#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <IOKit/hid/IOHIDManager.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <fcntl.h>
#import <unistd.h>

static const int kIPodVendorID = 0x05ac;
static const int kIPodNano2ProductID = 0x1260;
static const size_t kMaximumLineBytes = 64 * 1024;

static void HIDDeviceMatched(void *context, IOReturn result, void *sender, IOHIDDeviceRef device);
static void HIDDeviceRemoved(void *context, IOReturn result, void *sender, IOHIDDeviceRef device);
static void HIDValueReceived(void *context, IOReturn result, void *sender, IOHIDValueRef value);

static NSString *ControlForConsumerUsage(uint32_t usage) {
    switch (usage) {
        case 0x00e9: return @"volume-up";
        case 0x00ea: return @"volume-down";
        case 0x00e2: return @"mute";
        case 0x00cd: return @"toggle";
        case 0x00b7: return @"stop";
        case 0x00b5: return @"next";
        case 0x00b6: return @"previous";
        default: return nil;
    }
}

static NSString *DefaultSocketPath(void) {
    NSString *override = NSProcessInfo.processInfo.environment[@"POCKET_MUSIC_SOCKET"];
    if (override.length > 0) return override;
    return [NSHomeDirectory() stringByAppendingPathComponent:
            @"Library/Application Support/Pocket Music/pocket-music.sock"];
}

static NSDictionary *Track(NSString *identifier, NSString *title, NSString *artist,
                           NSString *album, double durationMilliseconds) {
    return @{
        @"id": identifier ?: @"",
        @"title": title ?: @"",
        @"artist": artist ?: @"",
        @"album": album ?: @"",
        @"durationMs": @(MAX(0, durationMilliseconds)),
    };
}

@interface PocketMusicDaemon : NSObject
@property(nonatomic) BOOL fixture;
@property(nonatomic) BOOL deviceConnected;
@property(nonatomic) BOOL fixturePlaying;
@property(nonatomic) NSInteger fixtureVolume;
@property(nonatomic) NSInteger sequence;
@property(nonatomic, copy) NSString *lastControl;
@property(nonatomic, copy) NSString *socketPath;
@property(nonatomic) int listener;
@property(nonatomic) IOHIDManagerRef hidManager;
@property(nonatomic, strong) dispatch_source_t listenerSource;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, dispatch_source_t> *clients;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSMutableData *> *clientBuffers;
@property(nonatomic, copy) NSData *lastBroadcast;
@end

@implementation PocketMusicDaemon

- (instancetype)initWithSocketPath:(NSString *)socketPath fixture:(BOOL)fixture {
    self = [super init];
    if (self) {
        _fixture = fixture;
        _deviceConnected = fixture;
        _fixturePlaying = YES;
        _fixtureVolume = 48;
        _socketPath = [socketPath copy];
        _listener = -1;
        _clients = [NSMutableDictionary dictionary];
        _clientBuffers = [NSMutableDictionary dictionary];
    }
    return self;
}

- (void)dealloc {
    if (_hidManager) CFRelease(_hidManager);
    if (_listener >= 0) close(_listener);
}

- (NSDictionary *)musicState {
    NSMutableDictionary *state = [@{
        @"t": @"pocket-music.state",
        @"daemonConnected": @YES,
        @"deviceConnected": @(self.deviceConnected),
        @"playerRunning": @NO,
        @"playing": @NO,
        @"positionMs": @0,
        @"volume": @0,
        @"sequence": @(self.sequence),
    } mutableCopy];
    if (self.lastControl.length > 0) state[@"lastControl"] = self.lastControl;

    if (self.fixture) {
        state[@"playerRunning"] = @YES;
        state[@"playing"] = @(self.fixturePlaying);
        state[@"positionMs"] = @(42000 + self.sequence * 250);
        state[@"volume"] = @(self.fixtureVolume);
        state[@"track"] = Track(@"fixture-window-seat", @"Window Seat",
                                  @"Pocket Music", @"Hardware Sessions", 240000);
        return state;
    }

    NSArray<NSRunningApplication *> *music =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.Music"];
    if (music.count == 0) return state;
    NSAppleScript *script = [[NSAppleScript alloc] initWithSource:
        @"tell application \"Music\"\n"
         "set t to current track\n"
         "return {persistent ID of t as text, name of t as text, artist of t as text, "
         "album of t as text, duration of t, player position, player state as text, sound volume}\n"
         "end tell"];
    NSDictionary *error = nil;
    NSAppleEventDescriptor *result = [script executeAndReturnError:&error];
    if (!result || result.numberOfItems < 8) {
        state[@"playerRunning"] = @YES;
        state[@"error"] = @"Music state unavailable";
        return state;
    }
    NSString *(^textAt)(NSInteger) = ^NSString *(NSInteger index) {
        return [result descriptorAtIndex:index].stringValue ?: @"";
    };
    double duration = [result descriptorAtIndex:5].doubleValue * 1000.0;
    double position = [result descriptorAtIndex:6].doubleValue * 1000.0;
    NSString *playerState = textAt(7).lowercaseString;
    state[@"playerRunning"] = @YES;
    state[@"playing"] = @([playerState isEqualToString:@"playing"]);
    state[@"positionMs"] = @(MAX(0, position));
    state[@"volume"] = @((NSInteger)MAX(0, MIN(100, [result descriptorAtIndex:8].int32Value)));
    state[@"track"] = Track(textAt(1), textAt(2), textAt(3), textAt(4), duration);
    return state;
}

- (BOOL)runAppleScript:(NSString *)source error:(NSString **)errorText {
    NSAppleScript *script = [[NSAppleScript alloc] initWithSource:source];
    NSDictionary *error = nil;
    NSAppleEventDescriptor *result = [script executeAndReturnError:&error];
    if (result) return YES;
    if (errorText) *errorText = error[NSAppleScriptErrorMessage] ?: @"Music command failed";
    return NO;
}

- (void)performControl:(NSString *)control source:(NSString *)source {
    NSSet<NSString *> *allowed = [NSSet setWithArray:@[
        @"toggle", @"next", @"previous", @"stop", @"mute", @"volume-up", @"volume-down"
    ]];
    if (![allowed containsObject:control]) return;
    self.sequence += 1;
    self.lastControl = control;
    if (self.fixture) {
        if ([control isEqualToString:@"toggle"]) self.fixturePlaying = !self.fixturePlaying;
        if ([control isEqualToString:@"stop"]) self.fixturePlaying = NO;
        if ([control isEqualToString:@"volume-up"]) self.fixtureVolume = MIN(100, self.fixtureVolume + 2);
        if ([control isEqualToString:@"volume-down"]) self.fixtureVolume = MAX(0, self.fixtureVolume - 2);
        if ([control isEqualToString:@"mute"]) self.fixtureVolume = self.fixtureVolume == 0 ? 48 : 0;
    } else {
        NSDictionary<NSString *, NSString *> *scripts = @{
            @"toggle": @"tell application \"Music\" to playpause",
            @"next": @"tell application \"Music\" to next track",
            @"previous": @"tell application \"Music\" to previous track",
            @"stop": @"tell application \"Music\" to stop",
            @"volume-up": @"tell application \"Music\"\nset v to sound volume + 2\nif v > 100 then set v to 100\nset sound volume to v\nend tell",
            @"volume-down": @"tell application \"Music\"\nset v to sound volume - 2\nif v < 0 then set v to 0\nset sound volume to v\nend tell",
            @"mute": @"tell application \"Music\"\nif sound volume is 0 then\nset sound volume to 48\nelse\nset sound volume to 0\nend if\nend tell",
        };
        NSString *error = nil;
        if (![self runAppleScript:scripts[control] error:&error]) {
            fprintf(stderr, "pocket-music-daemon: %s\n", error.UTF8String);
        }
    }
    NSDictionary *input = @{
        @"t": @"pocket-music.input",
        @"control": control,
        @"source": source,
        @"sequence": @(self.sequence),
    };
    [self broadcastDictionary:input force:YES];
    [self broadcastState:YES];
}

- (void)broadcastDictionary:(NSDictionary *)value force:(BOOL)force {
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    if (!json) {
        fprintf(stderr, "pocket-music-daemon: JSON encode failed: %s\n", error.localizedDescription.UTF8String);
        return;
    }
    NSMutableData *line = [json mutableCopy];
    const uint8_t newline = '\n';
    [line appendBytes:&newline length:1];
    if (!force && [line isEqualToData:self.lastBroadcast]) return;
    if (!force) self.lastBroadcast = line;
    for (NSNumber *descriptor in self.clients.allKeys.copy) {
        ssize_t sent = send(descriptor.intValue, line.bytes, line.length, MSG_NOSIGNAL | MSG_DONTWAIT);
        if ((sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) ||
            (sent >= 0 && (NSUInteger)sent != line.length)) {
            [self removeClient:descriptor.intValue];
        }
    }
}

- (void)broadcastState:(BOOL)force {
    [self broadcastDictionary:[self musicState] force:force];
}

- (void)removeClient:(int)descriptor {
    NSNumber *key = @(descriptor);
    dispatch_source_t source = self.clients[key];
    if (source) dispatch_source_cancel(source);
    [self.clients removeObjectForKey:key];
    [self.clientBuffers removeObjectForKey:key];
    close(descriptor);
}

- (void)handleClientBytes:(int)descriptor {
    uint8_t bytes[4096];
    ssize_t count = recv(descriptor, bytes, sizeof(bytes), 0);
    if (count <= 0) {
        if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) [self removeClient:descriptor];
        return;
    }
    NSMutableData *buffer = self.clientBuffers[@(descriptor)];
    [buffer appendBytes:bytes length:(NSUInteger)count];
    if (buffer.length > kMaximumLineBytes) {
        [self removeClient:descriptor];
        return;
    }
    while (YES) {
        const uint8_t *raw = buffer.bytes;
        NSUInteger newline = NSNotFound;
        for (NSUInteger i = 0; i < buffer.length; i++) {
            if (raw[i] == '\n') { newline = i; break; }
        }
        if (newline == NSNotFound) break;
        NSData *line = [buffer subdataWithRange:NSMakeRange(0, newline)];
        [buffer replaceBytesInRange:NSMakeRange(0, newline + 1) withBytes:NULL length:0];
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if (![command isKindOfClass:NSDictionary.class] ||
            ![command[@"t"] isEqual:@"pocket-music.command"] ||
            ![command[@"op"] isKindOfClass:NSString.class] || command.count != 2) continue;
        [self performControl:command[@"op"] source:@"pocketjs-app"];
    }
}

- (BOOL)startSocket:(NSError **)error {
    NSString *directory = self.socketPath.stringByDeletingLastPathComponent;
    if (![NSFileManager.defaultManager createDirectoryAtPath:directory
                                 withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    self.listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (self.listener < 0) return NO;
    fcntl(self.listener, F_SETFL, O_NONBLOCK);
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    NSData *path = [self.socketPath dataUsingEncoding:NSUTF8StringEncoding];
    if (path.length >= sizeof(address.sun_path)) return NO;
    memcpy(address.sun_path, path.bytes, path.length);
    unlink(address.sun_path);
    if (bind(self.listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        listen(self.listener, 4) != 0) return NO;
    chmod(address.sun_path, 0600);
    self.listenerSource = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_READ, (uintptr_t)self.listener, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.listenerSource, ^{
        while (YES) {
            int client = accept(self.listener, NULL, NULL);
            if (client < 0) break;
            fcntl(client, F_SETFL, O_NONBLOCK);
            NSNumber *key = @(client);
            self.clientBuffers[key] = [NSMutableData data];
            dispatch_source_t readSource = dispatch_source_create(
                DISPATCH_SOURCE_TYPE_READ, (uintptr_t)client, 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(readSource, ^{ [self handleClientBytes:client]; });
            self.clients[key] = readSource;
            dispatch_resume(readSource);
            [self broadcastState:YES];
        }
    });
    dispatch_resume(self.listenerSource);
    return YES;
}

- (BOOL)startHIDSeized:(BOOL)seized {
    self.hidManager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    NSDictionary *match = @{
        @kIOHIDVendorIDKey: @(kIPodVendorID),
        @kIOHIDProductIDKey: @(kIPodNano2ProductID),
    };
    IOHIDManagerSetDeviceMatching(self.hidManager, (__bridge CFDictionaryRef)match);
    IOHIDManagerRegisterDeviceMatchingCallback(self.hidManager, HIDDeviceMatched, (__bridge void *)self);
    IOHIDManagerRegisterDeviceRemovalCallback(self.hidManager, HIDDeviceRemoved, (__bridge void *)self);
    IOHIDManagerRegisterInputValueCallback(self.hidManager, HIDValueReceived, (__bridge void *)self);
    IOHIDManagerScheduleWithRunLoop(self.hidManager, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
    IOReturn result = IOHIDManagerOpen(
        self.hidManager, seized ? kIOHIDOptionsTypeSeizeDevice : kIOHIDOptionsTypeNone);
    if (result != kIOReturnSuccess) {
        fprintf(stderr, "pocket-music-daemon: cannot open iPod HID manager (0x%x)\n", result);
        return NO;
    }
    return YES;
}

- (void)runSeized:(BOOL)seized {
    NSError *error = nil;
    if (![self startSocket:&error]) {
        fprintf(stderr, "pocket-music-daemon: cannot listen on %s: %s\n",
                self.socketPath.UTF8String, error.localizedDescription.UTF8String);
        exit(1);
    }
    if (!self.fixture && ![self startHIDSeized:seized]) exit(1);
    dispatch_source_t timer = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), NSEC_PER_SEC, NSEC_PER_MSEC * 50);
    dispatch_source_set_event_handler(timer, ^{ [self broadcastState:NO]; });
    dispatch_resume(timer);
    fprintf(stderr, "pocket-music-daemon: listening on %s%s\n",
            self.socketPath.UTF8String, self.fixture ? " (fixture)" : "");
    CFRunLoopRun();
}

static void HIDDeviceMatched(void *context, IOReturn result, void *sender, IOHIDDeviceRef device) {
    (void)result; (void)sender; (void)device;
    PocketMusicDaemon *daemon = (__bridge PocketMusicDaemon *)context;
    daemon.deviceConnected = YES;
    [daemon broadcastState:YES];
}

static void HIDDeviceRemoved(void *context, IOReturn result, void *sender, IOHIDDeviceRef device) {
    (void)result; (void)sender; (void)device;
    PocketMusicDaemon *daemon = (__bridge PocketMusicDaemon *)context;
    daemon.deviceConnected = NO;
    [daemon broadcastState:YES];
}

static void HIDValueReceived(void *context, IOReturn result, void *sender, IOHIDValueRef value) {
    (void)result; (void)sender;
    CFIndex integerValue = IOHIDValueGetIntegerValue(value);
    if (integerValue <= 0) return;
    IOHIDElementRef element = IOHIDValueGetElement(value);
    if (IOHIDElementGetUsagePage(element) != 0x0c) return;
    NSString *control = ControlForConsumerUsage(IOHIDElementGetUsage(element));
    if (!control && integerValue <= UINT32_MAX) {
        // Rockbox emits Consumer Control as an array. In that report shape the
        // selected usage is the value; the element usage describes the array.
        control = ControlForConsumerUsage((uint32_t)integerValue);
    }
    if (!control) return;
    PocketMusicDaemon *daemon = (__bridge PocketMusicDaemon *)context;
    [daemon performControl:control source:@"ipod-nano-2g"];
}

@end

static BOOL SelfTest(void) {
    NSDictionary<NSNumber *, NSString *> *expected = @{
        @0x00e9: @"volume-up", @0x00ea: @"volume-down", @0x00e2: @"mute",
        @0x00cd: @"toggle", @0x00b7: @"stop", @0x00b5: @"next", @0x00b6: @"previous",
    };
    for (NSNumber *usage in expected) {
        if (![ControlForConsumerUsage(usage.unsignedIntValue) isEqual:expected[usage]]) return NO;
    }
    if (ControlForConsumerUsage(0x1234) != nil) return NO;
    PocketMusicDaemon *daemon = [[PocketMusicDaemon alloc] initWithSocketPath:@"/tmp/not-used" fixture:YES];
    [daemon performControl:@"volume-up" source:@"self-test"];
    [daemon performControl:@"toggle" source:@"self-test"];
    NSDictionary *state = [daemon musicState];
    return [state[@"volume"] integerValue] == 50 && ![state[@"playing"] boolValue] &&
           [state[@"sequence"] integerValue] == 2;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        (void)argc;
        (void)argv;
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        if ([arguments containsObject:@"--self-test"]) {
            if (!SelfTest()) return 1;
            puts("pocket-music-daemon: self-test passed");
            return 0;
        }
        BOOL fixture = [arguments containsObject:@"--fixture"];
        BOOL seized = ![arguments containsObject:@"--no-seize"];
        PocketMusicDaemon *daemon = [[PocketMusicDaemon alloc]
            initWithSocketPath:DefaultSocketPath() fixture:fixture];
        if ([arguments containsObject:@"--once"]) {
            NSData *json = [NSJSONSerialization dataWithJSONObject:[daemon musicState] options:0 error:nil];
            fwrite(json.bytes, 1, json.length, stdout);
            fputc('\n', stdout);
            return 0;
        }
        [daemon runSeized:seized];
    }
    return 0;
}
