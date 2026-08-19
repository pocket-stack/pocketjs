/* Immutable network policy: the canonical ResolvedNetworkPolicy JSON of the
 * application's Build Plan (contracts/spec/network-policy.ts, version 1),
 * handed to the runtime at creation by the host — which derives it from the
 * plan (HostBuildInputs.network.policyJson) and never authors one. Endpoint
 * tuples are matched before DNS, each candidate address after DNS, and
 * listen tuples before bind; redirects re-run the endpoint check. The guest
 * can never widen it. The parser accepts exactly the shapes the TypeScript
 * reference produces; contracts/spec/vectors/network-policy.json pins the
 * parse and match decisions shared with the Rust core. */
#include "pnet_internal.h"

#define PNET_POLICY_VERSION 1

static const char *PROTO_NAMES[PNET_PROTO_COUNT] = {"http", "https", "ws", "wss"};

pnet_proto pnet_proto_from_scheme(const char *scheme) {
  for (int i = 0; i < PNET_PROTO_COUNT; i++)
    if (strcmp(scheme, PROTO_NAMES[i]) == 0) return (pnet_proto)i;
  return PNET_PROTO_COUNT;
}

bool pnet_proto_is_plaintext(pnet_proto proto) {
  return proto == PNET_PROTO_HTTP || proto == PNET_PROTO_WS;
}

static bool parse_rule(pnet_runtime *rt, const pnet_jdoc *doc, int obj, bool listen, pnet_rule *rule) {
  memset(rule, 0, sizeof *rule);
  char buf[264];
  int proto = pnet_json_get(doc, obj, "protocol");
  if (!pnet_json_string(doc, proto, buf, sizeof buf, NULL)) return false;
  pnet_proto p = pnet_proto_from_scheme(buf);
  if (p == PNET_PROTO_COUNT) return false;
  if (listen && (p == PNET_PROTO_WS || p == PNET_PROTO_WSS)) {
    /* ws/wss listen tuples belong to the (staged) WebSocket server; accept
     * them for forward compatibility but they never match an HTTP listen. */
  }
  rule->proto = (uint8_t)p;
  int host = pnet_json_get(doc, obj, listen ? "address" : "host");
  size_t host_len;
  if (!pnet_json_string(doc, host, buf, sizeof buf, &host_len) || host_len == 0) return false;
  for (size_t i = 0; i < host_len; i++) {
    unsigned char ch = (unsigned char)buf[i];
    if (ch <= 0x20 || ch >= 0x7f) return false; /* ASCII (A-label) names only */
  }
  pnet_lower(buf, host_len);
  if (buf[host_len - 1] == '.' && host_len > 1) buf[--host_len] = 0;
  if (pnet_parse_ip_literal(buf, host_len, &rule->ip)) {
    rule->is_ip = true;
    /* Canonical storage: the literal's text form is irrelevant, matching
     * compares the binary address. */
  } else if (listen) {
    return false; /* listen addresses are IP literals */
  } else {
    const char *name = buf;
    size_t name_len = host_len;
    if (buf[0] == '*') {
      /* `*.suffix`: exactly one label; a bare `*` or `*.` is refused. */
      if (host_len < 3 || buf[1] != '.') return false;
      rule->wildcard = true;
      name = buf + 2;
      name_len = host_len - 2;
      pnet_addr tmp;
      if (pnet_parse_ip_literal(name, name_len, &tmp)) return false;
    }
    if (!pnet_hostname_valid(name, name_len)) return false;
  }
  rule->host = pnet_strdup_n(rt, buf, host_len);
  if (!rule->host) return false;
  int port = pnet_json_get(doc, obj, "port");
  int64_t v;
  if (pnet_json_type(doc, port) == PNET_J_NUMBER) {
    if (!pnet_json_i64(doc, port, &v) || v < 0 || v > 65535) return false;
    if (v == 0) return false;
    rule->port_min = rule->port_max = (uint16_t)v;
  } else if (pnet_json_type(doc, port) == PNET_J_STRING) {
    if (!listen || !pnet_json_string(doc, port, buf, sizeof buf, NULL) || strcmp(buf, "ephemeral") != 0) return false;
    rule->ephemeral = true;
  } else if (pnet_json_type(doc, port) == PNET_J_OBJECT) {
    int64_t lo, hi;
    if (!pnet_json_i64(doc, pnet_json_get(doc, port, "min"), &lo) || !pnet_json_i64(doc, pnet_json_get(doc, port, "max"), &hi))
      return false;
    if (lo < 1 || hi > 65535 || lo > hi) return false;
    rule->port_min = (uint16_t)lo;
    rule->port_max = (uint16_t)hi;
  } else {
    return false;
  }
  return true;
}

static bool parse_rules(pnet_runtime *rt, const pnet_jdoc *doc, int arr, bool listen, pnet_rule **out, size_t *count) {
  *out = NULL;
  *count = 0;
  if (arr < 0) return true;
  if (pnet_json_type(doc, arr) != PNET_J_ARRAY) return false;
  size_t n = 0;
  for (int e = pnet_json_first(doc, arr); e >= 0; e = pnet_json_next(doc, e)) n++;
  if (n == 0) return true;
  pnet_rule *rules = pnet_zalloc(rt, n * sizeof(pnet_rule));
  if (!rules) return false;
  size_t i = 0;
  for (int e = pnet_json_first(doc, arr); e >= 0; e = pnet_json_next(doc, e)) {
    if (!parse_rule(rt, doc, e, listen, &rules[i])) {
      for (size_t k = 0; k <= i; k++)
        if (rules[k].host) pnet_free_str(rt, rules[k].host);
      pnet_free(rt, rules, n * sizeof(pnet_rule));
      return false;
    }
    i++;
  }
  *out = rules;
  *count = n;
  return true;
}

bool pnet_policy_parse(pnet_runtime *rt, pnet_policy *policy, const char *json) {
  memset(policy, 0, sizeof *policy);
  if (!json) return false;
  size_t len = strlen(json);
  int cap = 512;
  pnet_jnode *nodes = pnet_alloc(rt, (size_t)cap * sizeof(pnet_jnode));
  if (!nodes) return false;
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, cap, json, len);
  bool ok = root >= 0 && pnet_json_type(&doc, root) == PNET_J_OBJECT;
  if (ok) {
    /* `version` is the contract version of the document; absent means 1
     * (host-authored test policies), anything else is a different contract. */
    int ver = pnet_json_get(&doc, root, "version");
    int64_t v;
    if (ver >= 0 && (!pnet_json_i64(&doc, ver, &v) || v != PNET_POLICY_VERSION)) ok = false;
  }
  if (ok) ok = parse_rules(rt, &doc, pnet_json_get(&doc, root, "connect"), false, &policy->connect, &policy->connect_count);
  if (ok) ok = parse_rules(rt, &doc, pnet_json_get(&doc, root, "listen"), true, &policy->listen, &policy->listen_count);
  if (ok) {
    int creds = pnet_json_get(&doc, root, "credentials");
    if (creds >= 0) {
      if (pnet_json_type(&doc, creds) != PNET_J_ARRAY) ok = false;
      else {
        size_t n = 0;
        for (int e = pnet_json_first(&doc, creds); e >= 0; e = pnet_json_next(&doc, e)) n++;
        if (n) {
          policy->credentials = pnet_zalloc(rt, n * sizeof(char *));
          if (!policy->credentials) ok = false;
          else {
            policy->credential_count = n;
            size_t i = 0;
            for (int e = pnet_json_first(&doc, creds); e >= 0 && ok; e = pnet_json_next(&doc, e)) {
              policy->credentials[i] = pnet_json_string_dup(rt, &doc, e, NULL);
              if (!policy->credentials[i]) ok = false;
              i++;
            }
          }
        }
      }
    }
  }
  if (ok) {
    int f = pnet_json_get(&doc, root, "insecureTransport");
    policy->insecure_transport = f >= 0 && pnet_json_type(&doc, f) == PNET_J_BOOL && doc.nodes[f].truthy;
    f = pnet_json_get(&doc, root, "localNetwork");
    policy->local_network = f >= 0 && pnet_json_type(&doc, f) == PNET_J_BOOL && doc.nodes[f].truthy;
    f = pnet_json_get(&doc, root, "allowInvalidTlsForDevelopment");
    policy->allow_invalid_tls_for_development = f >= 0 && pnet_json_type(&doc, f) == PNET_J_BOOL && doc.nodes[f].truthy;
  }
  pnet_free(rt, nodes, (size_t)cap * sizeof(pnet_jnode));
  if (!ok) pnet_policy_free(rt, policy);
  return ok;
}

void pnet_policy_free(pnet_runtime *rt, pnet_policy *policy) {
  for (size_t i = 0; i < policy->connect_count; i++)
    if (policy->connect[i].host) pnet_free_str(rt, policy->connect[i].host);
  if (policy->connect) pnet_free(rt, policy->connect, policy->connect_count * sizeof(pnet_rule));
  for (size_t i = 0; i < policy->listen_count; i++)
    if (policy->listen[i].host) pnet_free_str(rt, policy->listen[i].host);
  if (policy->listen) pnet_free(rt, policy->listen, policy->listen_count * sizeof(pnet_rule));
  for (size_t i = 0; i < policy->credential_count; i++)
    if (policy->credentials[i]) pnet_free_str(rt, policy->credentials[i]);
  if (policy->credentials) pnet_free(rt, policy->credentials, policy->credential_count * sizeof(char *));
  memset(policy, 0, sizeof *policy);
}

static bool host_matches(const pnet_rule *rule, const char *host) {
  if (rule->is_ip) {
    pnet_addr a;
    if (!pnet_parse_ip_literal(host, strlen(host), &a)) return false;
    return a.family == rule->ip.family && memcmp(a.addr, rule->ip.addr, a.family == 4 ? 4 : 16) == 0;
  }
  if (rule->wildcard) {
    /* "*.example.com" matches exactly one non-empty label. */
    const char *suffix = rule->host + 1; /* ".example.com" */
    size_t hl = strlen(host), sl = strlen(suffix);
    if (hl <= sl) return false;
    if (strcmp(host + (hl - sl), suffix) != 0) return false;
    size_t label = hl - sl;
    if (label == 0) return false;
    for (size_t i = 0; i < label; i++)
      if (host[i] == '.') return false;
    return true;
  }
  return strcmp(rule->host, host) == 0;
}

static bool port_matches(const pnet_rule *rule, uint16_t port) {
  if (rule->ephemeral) return port == 0;
  return port >= rule->port_min && port <= rule->port_max;
}

bool pnet_policy_allows_connect(const pnet_policy *p, pnet_proto proto, const char *host, uint16_t port) {
  if (pnet_proto_is_plaintext(proto) && !p->insecure_transport) return false;
  for (size_t i = 0; i < p->connect_count; i++) {
    const pnet_rule *r = &p->connect[i];
    if (r->proto != (uint8_t)proto) continue;
    if (!port_matches(r, port)) continue;
    if (host_matches(r, host)) return true;
  }
  return false;
}

bool pnet_policy_allows_address(const pnet_policy *p, const pnet_addr *addr) {
  if (pnet_addr_is_multicast(addr)) return false;
  if (pnet_addr_is_public(addr)) return true;
  return p->local_network;
}

bool pnet_policy_allows_listen(const pnet_policy *p, pnet_proto proto, const pnet_addr *addr, uint16_t port) {
  if (pnet_proto_is_plaintext(proto) && !p->insecure_transport) return false;
  for (size_t i = 0; i < p->listen_count; i++) {
    const pnet_rule *r = &p->listen[i];
    if (r->proto != (uint8_t)proto) continue;
    if (!port_matches(r, port)) continue;
    if (!r->is_ip) continue;
    if (r->ip.family != addr->family) continue;
    if (memcmp(r->ip.addr, addr->addr, addr->family == 4 ? 4 : 16) != 0) continue;
    return true;
  }
  return false;
}

bool pnet_policy_has_credential(const pnet_policy *p, const char *id) {
  for (size_t i = 0; i < p->credential_count; i++)
    if (strcmp(p->credentials[i], id) == 0) return true;
  return false;
}
