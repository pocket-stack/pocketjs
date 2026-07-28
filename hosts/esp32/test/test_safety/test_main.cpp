#include <unity.h>

#include "safety.h"

using symbian::BoundedEventQueue;
using symbian::OutputLease;
using symbian::isSandboxWritePath;

void setUp() {}
void tearDown() {}

void test_output_lease_starts_locked_and_expires() {
    OutputLease lease(30000, 2000);
    TEST_ASSERT_FALSE(lease.isUnlocked(0));
    lease.unlock(1000);
    TEST_ASSERT_TRUE(lease.isUnlocked(1000));
    TEST_ASSERT_TRUE(lease.isUnlocked(30999));
    TEST_ASSERT_FALSE(lease.isUnlocked(31000));
}

void test_motor_deadman_stops_without_refresh() {
    OutputLease lease(30000, 2000);
    lease.unlock(100);
    TEST_ASSERT_TRUE(lease.startMotor(1, 100));
    TEST_ASSERT_TRUE(lease.motorRunning(1, 2099));
    TEST_ASSERT_FALSE(lease.motorRunning(1, 2100));
}

void test_locked_lease_rejects_motor_and_all_off_clears_everything() {
    OutputLease lease(30000, 2000);
    TEST_ASSERT_FALSE(lease.startMotor(1, 0));
    lease.unlock(0);
    TEST_ASSERT_TRUE(lease.startMotor(1, 0));
    TEST_ASSERT_TRUE(lease.startMotor(2, 0));
    lease.allOff();
    TEST_ASSERT_FALSE(lease.isUnlocked(1));
    TEST_ASSERT_FALSE(lease.motorRunning(1, 1));
    TEST_ASSERT_FALSE(lease.motorRunning(2, 1));
}

void test_event_queue_is_fifo_and_drops_oldest_at_capacity() {
    BoundedEventQueue<3, 16> queue;
    TEST_ASSERT_TRUE(queue.push("one"));
    TEST_ASSERT_TRUE(queue.push("two"));
    TEST_ASSERT_TRUE(queue.push("three"));
    TEST_ASSERT_TRUE(queue.push("four"));
    TEST_ASSERT_EQUAL_UINT32(1, queue.dropped());

    char output[16] = {};
    TEST_ASSERT_TRUE(queue.pop(output, sizeof(output)));
    TEST_ASSERT_EQUAL_STRING("two", output);
    TEST_ASSERT_TRUE(queue.pop(output, sizeof(output)));
    TEST_ASSERT_EQUAL_STRING("three", output);
    TEST_ASSERT_TRUE(queue.pop(output, sizeof(output)));
    TEST_ASSERT_EQUAL_STRING("four", output);
    TEST_ASSERT_FALSE(queue.pop(output, sizeof(output)));
}

void test_sd_writes_are_confined_to_symbian_pocket() {
    TEST_ASSERT_TRUE(isSandboxWritePath("/SymbianPocket"));
    TEST_ASSERT_TRUE(isSandboxWritePath("/SymbianPocket/notes.txt"));
    TEST_ASSERT_TRUE(isSandboxWritePath("/SymbianPocket/folder/item.txt"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/other/item.txt"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/SymbianPocket/../escape.txt"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/SymbianPocket/folder/../../escape.txt"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/SymbianPocket/"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/SymbianPocket//item.txt"));
    TEST_ASSERT_FALSE(isSandboxWritePath("/SymbianPocket/C:\\item.txt"));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_output_lease_starts_locked_and_expires);
    RUN_TEST(test_motor_deadman_stops_without_refresh);
    RUN_TEST(test_locked_lease_rejects_motor_and_all_off_clears_everything);
    RUN_TEST(test_event_queue_is_fifo_and_drops_oldest_at_capacity);
    RUN_TEST(test_sd_writes_are_confined_to_symbian_pocket);
    return UNITY_END();
}
