#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace symbian {

bool isSandboxWritePath(const char* path);

class OutputLease {
public:
    OutputLease(std::uint32_t unlockDurationMs, std::uint32_t motorDeadmanMs);

    void unlock(std::uint32_t nowMs);
    bool isUnlocked(std::uint32_t nowMs) const;
    bool startMotor(unsigned channel, std::uint32_t nowMs);
    void refreshMotor(unsigned channel, std::uint32_t nowMs);
    bool motorRunning(unsigned channel, std::uint32_t nowMs) const;
    void stopMotor(unsigned channel);
    void allOff();

private:
    static bool beforeDeadline(std::uint32_t nowMs, std::uint32_t deadlineMs);

    std::uint32_t unlockDurationMs_;
    std::uint32_t motorDeadmanMs_;
    std::uint32_t unlockDeadlineMs_ = 0;
    std::array<std::uint32_t, 2> motorDeadlineMs_ = {0, 0};
    bool unlocked_ = false;
    std::array<bool, 2> motorActive_ = {false, false};
};

template <std::size_t Capacity, std::size_t ItemBytes>
class BoundedEventQueue {
public:
    static_assert(Capacity > 0, "event queue requires at least one slot");
    static_assert(ItemBytes > 1, "event queue items need room for a terminator");

    bool push(const char* value) {
        if (!value) return false;
        if (count_ == Capacity) {
            head_ = (head_ + 1) % Capacity;
            --count_;
            ++dropped_;
        }
        auto& destination = items_[(head_ + count_) % Capacity];
        std::strncpy(destination.data(), value, ItemBytes - 1);
        destination[ItemBytes - 1] = '\0';
        ++count_;
        return true;
    }

    bool pop(char* output, std::size_t capacity) {
        if (!output || capacity == 0 || count_ == 0) return false;
        const auto& source = items_[head_];
        std::strncpy(output, source.data(), capacity - 1);
        output[capacity - 1] = '\0';
        head_ = (head_ + 1) % Capacity;
        --count_;
        return true;
    }

    std::size_t size() const { return count_; }
    std::uint32_t dropped() const { return dropped_; }

private:
    std::array<std::array<char, ItemBytes>, Capacity> items_{};
    std::size_t head_ = 0;
    std::size_t count_ = 0;
    std::uint32_t dropped_ = 0;
};

}  // namespace symbian
