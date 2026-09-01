// CJS shim: a minimal posix `path` — enough for babel's filename bookkeeping.
"use strict";
function assertPath(p) {
  if (typeof p !== "string") throw new TypeError("path must be a string");
}
function normalize(p) {
  assertPath(p);
  if (!p) return ".";
  const abs = p.charCodeAt(0) === 47;
  const parts = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
    } else parts.push(seg);
  }
  let r = parts.join("/");
  if (!r) r = abs ? "/" : ".";
  else if (abs) r = "/" + r;
  return r;
}
function join(...a) {
  const f = a.filter((x) => x && typeof x === "string");
  return f.length ? normalize(f.join("/")) : ".";
}
function dirname(p) {
  assertPath(p);
  if (!p) return ".";
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}
function basename(p, ext) {
  assertPath(p);
  let b = p.slice(p.lastIndexOf("/") + 1);
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}
function extname(p) {
  assertPath(p);
  const b = p.slice(p.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}
function isAbsolute(p) {
  assertPath(p);
  return p.charCodeAt(0) === 47;
}
function relative(from, to) {
  from = normalize(from);
  to = normalize(to);
  return from === to ? "" : to;
}
function resolve(...a) {
  let r = "";
  let abs = false;
  for (let i = a.length - 1; i >= -1 && !abs; i--) {
    const p = i >= 0 ? a[i] : "/";
    if (!p) continue;
    r = p + "/" + r;
    abs = p.charCodeAt(0) === 47;
  }
  r = normalize(r);
  return abs ? (r.charCodeAt(0) === 47 ? r : "/" + r) : r || ".";
}
const path = { normalize, join, dirname, basename, extname, isAbsolute, relative, resolve, sep: "/", delimiter: ":" };
path.posix = path;
path.win32 = path;
path.default = path;
module.exports = path;
