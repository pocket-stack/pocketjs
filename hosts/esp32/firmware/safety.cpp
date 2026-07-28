#include "safety.h"

namespace symbian {

bool isSandboxWritePath(const char* path) {
    if (!path) return false;
    if (std::strcmp(path, "/SymbianPocket") == 0) return true;
    if (std::strncmp(path, "/SymbianPocket/", 15) != 0) return false;
    const char* segment = path + 15;
    if (!*segment) return false;
    while (*segment) {
        const char* end = std::strchr(segment, '/');
        const std::size_t length = end ? static_cast<std::size_t>(end - segment)
                                       : std::strlen(segment);
        if (length == 0 ||
            (length == 1 && segment[0] == '.') ||
            (length == 2 && segment[0] == '.' && segment[1] == '.')) {
            return false;
        }
        for (std::size_t index = 0; index < length; ++index) {
            const unsigned char value = static_cast<unsigned char>(segment[index]);
            if (value < 0x20 || value == '\\' || value == ':') return false;
        }
        if (!end) break;
        segment = end + 1;
        if (!*segment) return false;
    }
    return true;
}

OutputLease::OutputLease(std::uint32_t unlockDurationMs, std::uint32_t motorDeadmanMs)
    : unlockDurationMs_(unlockDurationMs), motorDeadmanMs_(motorDeadmanMs) {}

bool OutputLease::beforeDeadline(std::uint32_t nowMs, std::uint32_t deadlineMs) {
    return static_cast<std::int32_t>(deadlineMs - nowMs) > 0;
}

void OutputLease::unlock(std::uint32_t nowMs) {
    unlocked_ = true;
    unlockDeadlineMs_ = nowMs + unlockDurationMs_;
}

bool OutputLease::isUnlocked(std::uint32_t nowMs) const {
    return unlocked_ && beforeDeadline(nowMs, unlockDeadlineMs_);
}

bool OutputLease::startMotor(unsigned channel, std::uint32_t nowMs) {
    if (channel < 1 || channel > 2 || !isUnlocked(nowMs)) return false;
    motorActive_[channel - 1] = true;
    motorDeadlineMs_[channel - 1] = nowMs + motorDeadmanMs_;
    return true;
}

void OutputLease::refreshMotor(unsigned channel, std::uint32_t nowMs) {
    if (channel < 1 || channel > 2 || !motorActive_[channel - 1] || !isUnlocked(nowMs)) return;
    motorDeadlineMs_[channel - 1] = nowMs + motorDeadmanMs_;
}

bool OutputLease::motorRunning(unsigned channel, std::uint32_t nowMs) const {
    if (channel < 1 || channel > 2 || !isUnlocked(nowMs)) return false;
    return motorActive_[channel - 1] && beforeDeadline(nowMs, motorDeadlineMs_[channel - 1]);
}

void OutputLease::stopMotor(unsigned channel) {
    if (channel < 1 || channel > 2) return;
    motorActive_[channel - 1] = false;
    motorDeadlineMs_[channel - 1] = 0;
}

void OutputLease::allOff() {
    unlocked_ = false;
    unlockDeadlineMs_ = 0;
    motorActive_ = {false, false};
    motorDeadlineMs_ = {0, 0};
}

}  // namespace symbian
