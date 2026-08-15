// PocketSurfaceView — a UIKit view that hosts one PocketJS guest: display-link
// driven ticks, packed touch input, and damage-gated compositing of the
// software-rasterized ARGB framebuffer. Main thread only.

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface PocketSurfaceView : UIView

// density is the raster scale (1..4; use 2 or 3 to match screen scale).
- (instancetype)initWithFrame:(CGRect)frame
                 logicalWidth:(uint32_t)logicalWidth
                logicalHeight:(uint32_t)logicalHeight
                      density:(uint32_t)density;

// Struct-free convenience for bridged callers; frame starts at zero and is
// laid out by the parent view system.
+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density;

// Standalone hosts that share PocketSurfaceView's ABI but publish a distinct
// platform target use this initializer. The default initializer above keeps
// publishing ios-dev/7 for the NativeScript shell.
+ (instancetype)surfaceWithLogicalWidth:(uint32_t)logicalWidth
                          logicalHeight:(uint32_t)logicalHeight
                                density:(uint32_t)density
                                 hostId:(NSString *)hostId
                                hostAbi:(uint32_t)hostAbi;

// External-guest mode: no embedded QuickJS realm — the embedding runtime
// (e.g. NativeScript) owns the guest, mounts globalThis.ui over the ui*
// methods below, and receives onTick to run globalThis.frame each display
// tick. evalBundle is invalid in this mode; loadPak feeds the core directly.
+ (instancetype)externalSurfaceWithLogicalWidth:(uint32_t)logicalWidth
                                  logicalHeight:(uint32_t)logicalHeight
                                        density:(uint32_t)density;

// External mode only: runs before the core tick; call globalThis.frame here.
@property(nonatomic, copy, nullable) void (^onTick)
    (uint32_t buttons, uint32_t analog, NSArray<NSNumber *> *touches);

// ---- external-guest ui.* ops --------------------------------------------
- (int32_t)uiCreateNode:(int32_t)nodeType;
- (void)uiDestroyNode:(int32_t)nodeId;
- (void)uiInsertBefore:(int32_t)parent child:(int32_t)child anchor:(int32_t)anchor;
- (void)uiRemoveChild:(int32_t)parent child:(int32_t)child;
- (void)uiSetStyle:(int32_t)nodeId style:(int32_t)styleId;
- (void)uiSetProp:(int32_t)nodeId prop:(int32_t)prop value:(double)value;
- (void)uiSetText:(int32_t)nodeId text:(NSString *)text;
- (void)uiReplaceText:(int32_t)nodeId text:(NSString *)text;
- (float)uiMeasureText:(NSString *)text fontSlot:(int32_t)fontSlot;
- (int32_t)uiUploadTexture:(NSData *)pixels width:(uint32_t)width height:(uint32_t)height psm:(uint32_t)psm;
- (void)uiSetImage:(int32_t)nodeId texture:(int32_t)texture;
- (void)uiSetSprite:(int32_t)nodeId atlas:(int32_t)atlas frames:(int32_t)frames cols:(int32_t)cols step:(int32_t)step;
- (int32_t)uiAnimate:(int32_t)nodeId prop:(int32_t)prop to:(double)to dur:(int32_t)durationMs easing:(int32_t)easing delay:(int32_t)delayMs;
- (void)uiCancelAnim:(int32_t)animId;
- (void)uiSetFocus:(int32_t)nodeId;
- (void)uiSetActive:(int32_t)nodeId active:(int32_t)active;
- (int32_t)uiHitTestBounds:(float)x y:(float)y;
- (NSDictionary<NSString *, NSNumber *> *)uiTextures;
- (NSArray<NSDictionary<NSString *, NSNumber *> *> *)uiSprites;
- (void)uiSvcSend:(NSString *)line;
- (NSString *_Nullable)uiSvcPoll;
- (BOOL)uiSvcOpen:(NSString *)name;

// Feed assets before start. Returns NO with `lastError` set on failure.
- (BOOL)loadPak:(NSData *)pak;
- (BOOL)evalBundle:(NSString *)source label:(nullable NSString *)label;

// Convenience: reads <name>.js and <name>.pak from a directory.
- (BOOL)loadAppNamed:(NSString *)name fromDirectory:(NSString *)directory;

// Ticks per second of guest virtual time, and the rate the display link is
// pinned to. 0 means the 60 Hz default. Set before the bundle evaluates
// (evalBundle here, or the embedding runtime's guest eval in external mode):
// the mount publishes the rate to the guest as ui.__tickHz, and a later set
// is rejected through lastError/onError, keeping the declared rate. The
// bundle must have been built for the same rate (`pocket ios build --hz=<n>`).
@property(nonatomic) uint32_t tickRate;

// Starts/stops the CADisplayLink. start after evalBundle succeeds.
- (void)start;

// Starts a 60 Hz main-run-loop timer instead of CADisplayLink. Connected
// device hosts use this only when their runtime does not deliver display-link
// callbacks; it is mutually exclusive with start.
- (void)startWithFixedFrameTimer;
- (void)stop;

// Guest -> host effect lines (JSON by convention), delivered on the main
// thread during the display tick.
@property(nonatomic, copy, nullable) void (^onEffect)(NSString *line);

// Called after a guest frame has advanced and rendered successfully. Native
// device hosts use this for liveness and touch receipts without observing or
// changing application state.
@property(nonatomic, copy, nullable) void (^onFrame)
    (uint64_t frameNumber, NSUInteger touchCount);

// Host -> guest: queued for the guest's next poll (frame-boundary delivery).
- (void)postEvent:(NSString *)line;

@property(nonatomic, readonly) uint32_t logicalWidth;
@property(nonatomic, readonly) uint32_t logicalHeight;
@property(nonatomic, readonly, nullable) NSString *lastError;
@property(nonatomic, copy, nullable) void (^onError)(NSString *message);

@end

NS_ASSUME_NONNULL_END
