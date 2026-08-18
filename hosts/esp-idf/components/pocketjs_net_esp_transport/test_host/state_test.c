// SPDX-License-Identifier: MIT

#include <assert.h>
#include <stdint.h>

#include "transport_state.h"

int main(void) {
  assert(pocketjs_net_select_tls_certificate_flags(0U, 0U) == 0U);
  assert(pocketjs_net_select_tls_certificate_flags(0x08U, 0U) == 0x08U);
  assert(pocketjs_net_select_tls_certificate_flags(0U, 0x04U) == 0x04U);
  assert(pocketjs_net_select_tls_certificate_flags(0x08U, 0x04U) == 0x04U);
  assert(pocketjs_net_select_tls_certificate_flags(0x08U, UINT32_MAX) == 0x08U);
  static const pocketjs_net_tls_error_symbols_t tls_symbols = {
      .certificate_verify_failed = -0x2700,
      .bad_certificate = -0x7a00,
      .ca_chain_required = -0x7680,
      .bad_protocol_version = -0x6e80,
      .fatal_alert_message = -0x7780,
      .allocation_failed = -0x007f,
      .hostname_mismatch_flag = 0x04U,
  };
  assert(pocketjs_net_classify_tls_error(-0x2700, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID);
  assert(pocketjs_net_classify_tls_error(0x2700, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID);
  assert(pocketjs_net_classify_tls_error(-0x1234, 0x04U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_HOSTNAME_MISMATCH);
  assert(pocketjs_net_classify_tls_error(-0x1234, 0x08U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID);
  assert(pocketjs_net_classify_tls_error(-0x1234, UINT32_MAX, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_HANDSHAKE_FAILED);
  assert(pocketjs_net_classify_tls_error(0x7a00, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID);
  assert(pocketjs_net_classify_tls_error(-0x7680, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID);
  assert(pocketjs_net_classify_tls_error(0x6e80, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_VERSION_UNSUPPORTED);
  assert(pocketjs_net_classify_tls_error(-0x7780, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_ALERT);
  assert(pocketjs_net_classify_tls_error(0x007f, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_RESOURCE_LIMIT);
  assert(pocketjs_net_classify_tls_error(-0x1234, 0U, &tls_symbols) ==
         POCKETJS_NET_TLS_ERROR_CLASS_HANDSHAKE_FAILED);
  assert(pocketjs_net_classify_tls_error(-0x2700, 0U, NULL) ==
         POCKETJS_NET_TLS_ERROR_CLASS_HANDSHAKE_FAILED);
  assert(pocketjs_net_classify_tls_close_notify(0, -0x6900, -0x6880) ==
         POCKETJS_NET_TLS_CLOSE_NOTIFY_COMPLETE);
  assert(pocketjs_net_classify_tls_close_notify(-0x6900, -0x6900, -0x6880) ==
         POCKETJS_NET_TLS_CLOSE_NOTIFY_RETRY);
  assert(pocketjs_net_classify_tls_close_notify(-0x6880, -0x6900, -0x6880) ==
         POCKETJS_NET_TLS_CLOSE_NOTIFY_RETRY);
  assert(pocketjs_net_classify_tls_close_notify(-0x1234, -0x6900, -0x6880) ==
         POCKETJS_NET_TLS_CLOSE_NOTIFY_FAILED);

  pocketjs_net_token_gate_t gate = {0};
  assert(!pocketjs_net_token_gate_can_accept(&gate, 0));
  assert(pocketjs_net_token_gate_can_accept(&gate, 1));
  pocketjs_net_token_gate_consume(&gate, 1);
  assert(!pocketjs_net_token_gate_can_accept(&gate, 1));
  assert(pocketjs_net_token_gate_can_accept(&gate, UINT64_MAX));
  pocketjs_net_token_gate_consume(&gate, UINT64_MAX);
  assert(!pocketjs_net_token_gate_can_accept(&gate, UINT64_MAX));

  assert(!pocketjs_net_dns_candidate_prefix_saturated(0U, 4U));
  assert(!pocketjs_net_dns_candidate_prefix_saturated(3U, 4U));
  assert(pocketjs_net_dns_candidate_prefix_saturated(4U, 4U));
  assert(pocketjs_net_dns_candidate_prefix_saturated(5U, 4U));
  assert(pocketjs_net_dns_candidate_prefix_saturated(0U, 0U));
  assert(!pocketjs_net_dns_callback_ticket_matches(false, 7U, 7U));
  assert(!pocketjs_net_dns_callback_ticket_matches(true, 0U, 0U));
  assert(pocketjs_net_dns_callback_ticket_matches(true, 7U, 7U));
  assert(!pocketjs_net_dns_callback_ticket_matches(true, 8U, 7U));

  uint64_t generation = 0;
  assert(pocketjs_net_generation_advance(&generation));
  assert(generation == 1);
  generation = UINT64_MAX;
  assert(!pocketjs_net_generation_advance(&generation));
  assert(generation == UINT64_MAX);

  pocketjs_net_terminal_credits_t credits = {.capacity = 2};
  assert(pocketjs_net_terminal_credit_invariant(&credits));
  assert(pocketjs_net_terminal_credit_reserve(&credits));
  assert(pocketjs_net_terminal_credit_reserve(&credits));
  assert(!pocketjs_net_terminal_credit_reserve(&credits));
  assert(pocketjs_net_terminal_credit_enqueue(&credits));
  assert(pocketjs_net_terminal_credit_take(&credits));
  assert(!pocketjs_net_terminal_credit_reserve(&credits));
  assert(pocketjs_net_terminal_credit_retire(&credits));
  assert(pocketjs_net_terminal_credit_reserve(&credits));

  /* Admission is serialized with shutdown. A shutdown-first interleaving
   * consumes neither a token nor a terminal credit. */
  pocketjs_net_token_gate_t admission_gate = {0};
  pocketjs_net_terminal_credits_t admission_credits = {.capacity = 1};
  pocketjs_net_operation_lifecycle_t admission_lifecycle =
      POCKETJS_NET_OPERATION_FREE;
  uint64_t admitted_token = 0U;
  assert(pocketjs_net_operation_admit(
             true, &admission_gate, &admission_credits, &admission_lifecycle,
             &admitted_token, 41U) == POCKETJS_NET_OPERATION_ADMISSION_CLOSING);
  assert(admission_lifecycle == POCKETJS_NET_OPERATION_FREE);
  assert(admission_gate.last == 0U);
  assert(admission_credits.reserved == 0U);
  assert(pocketjs_net_operation_admit(false, &admission_gate,
                                      &admission_credits, &admission_lifecycle,
                                      &admitted_token, 41U) ==
         POCKETJS_NET_OPERATION_ADMISSION_ACCEPTED);
  assert(admission_lifecycle == POCKETJS_NET_OPERATION_ACTIVE);
  assert(admitted_token == 41U);
  assert(admission_gate.last == 41U);
  assert(admission_credits.reserved == 1U);

  pocketjs_net_operation_lifecycle_t lifecycle = POCKETJS_NET_OPERATION_ACTIVE;
  assert(pocketjs_net_operation_claim_terminal(&lifecycle));
  /* A late native success loses after abort/timeout has claimed terminal. */
  assert(!pocketjs_net_operation_claim_terminal(&lifecycle));
  assert(pocketjs_net_operation_begin_delivery(&lifecycle));
  assert(!pocketjs_net_operation_begin_delivery(&lifecycle));
  assert(pocketjs_net_operation_retire(&lifecycle));
  assert(lifecycle == POCKETJS_NET_OPERATION_FREE);

  /* A stale cancellation ticket cannot match a reused operation slot. */
  assert(!pocketjs_net_operation_ticket_matches(lifecycle, 10, 10));
  lifecycle = POCKETJS_NET_OPERATION_ACTIVE;
  assert(pocketjs_net_operation_ticket_matches(lifecycle, 11, 11));
  assert(!pocketjs_net_operation_ticket_matches(lifecycle, 11, 10));

  /* cancel, deadline, and native completion use one serialized terminal
   * transition. Cancellation wins when it was published first. */
  lifecycle = POCKETJS_NET_OPERATION_ACTIVE;
  assert(
      !pocketjs_net_operation_claim_native_terminal(&lifecycle, true, false));
  assert(
      pocketjs_net_operation_claim_cancel_or_timeout(&lifecycle, true, true) ==
      POCKETJS_NET_OPERATION_TERMINAL_ABORTED);
  assert(
      !pocketjs_net_operation_claim_native_terminal(&lifecycle, false, false));

  lifecycle = POCKETJS_NET_OPERATION_ACTIVE;
  assert(
      !pocketjs_net_operation_claim_native_terminal(&lifecycle, false, true));
  assert(
      pocketjs_net_operation_claim_cancel_or_timeout(&lifecycle, false, true) ==
      POCKETJS_NET_OPERATION_TERMINAL_TIMED_OUT);

  lifecycle = POCKETJS_NET_OPERATION_ACTIVE;
  assert(
      pocketjs_net_operation_claim_native_terminal(&lifecycle, false, false));
  assert(pocketjs_net_operation_claim_cancel_or_timeout(
             &lifecycle, true, true) == POCKETJS_NET_OPERATION_TERMINAL_NONE);

  size_t cursor = 0U;
  bool visited[8] = {false};
  for (size_t index = 0; index < 8U; ++index) {
    visited[cursor] = true;
    cursor = pocketjs_net_round_robin_next(cursor, 8U);
  }
  assert(cursor == 0U);
  for (size_t index = 0; index < 8U; ++index) {
    assert(visited[index]);
  }

  assert(!pocketjs_net_operation_cancel_closes_connection(
      POCKETJS_NET_TRANSPORT_OPERATION_RESOLVE));
  assert(pocketjs_net_operation_cancel_closes_connection(
      POCKETJS_NET_TRANSPORT_OPERATION_CONNECT));
  assert(pocketjs_net_operation_cancel_closes_connection(
      POCKETJS_NET_TRANSPORT_OPERATION_READ));
  assert(pocketjs_net_operation_cancel_closes_connection(
      POCKETJS_NET_TRANSPORT_OPERATION_WRITE));
  assert(pocketjs_net_operation_cancel_closes_connection(
      POCKETJS_NET_TRANSPORT_OPERATION_CLOSE));
  assert(pocketjs_net_operation_shutdown_requests_cancel(
      POCKETJS_NET_TRANSPORT_OPERATION_RESOLVE));
  assert(pocketjs_net_operation_shutdown_requests_cancel(
      POCKETJS_NET_TRANSPORT_OPERATION_CONNECT));
  assert(pocketjs_net_operation_shutdown_requests_cancel(
      POCKETJS_NET_TRANSPORT_OPERATION_READ));
  assert(pocketjs_net_operation_shutdown_requests_cancel(
      POCKETJS_NET_TRANSPORT_OPERATION_WRITE));
  assert(!pocketjs_net_operation_shutdown_requests_cancel(
      POCKETJS_NET_TRANSPORT_OPERATION_CLOSE));
  return 0;
}
