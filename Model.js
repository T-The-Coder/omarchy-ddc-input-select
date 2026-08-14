// Pure parsing helpers for the Monitor Input plugin. No QML types in here so
// the logic stays testable with a plain JS runtime (see `make test-model`).

// Input Source values defined by MCCS 2.x for VCP feature 0x60. Monitors are
// free to add vendor codes outside this table — the Dell U5226KW uses 0x13 and
// 0x19, neither of which is standard — so this is a naming aid for discovered
// codes, never the list of what a monitor actually has. That list comes from
// the monitor itself via parseCapabilities().
var MCCS_INPUT_NAMES = {
  "0x01": "VGA-1",
  "0x02": "VGA-2",
  "0x03": "DVI-1",
  "0x04": "DVI-2",
  "0x05": "Composite-1",
  "0x06": "Composite-2",
  "0x07": "S-Video-1",
  "0x08": "S-Video-2",
  "0x09": "Tuner-1",
  "0x0a": "Tuner-2",
  "0x0b": "Tuner-3",
  "0x0c": "Component-1",
  "0x0d": "Component-2",
  "0x0e": "Component-3",
  "0x0f": "DisplayPort-1",
  "0x10": "DisplayPort-2",
  "0x11": "HDMI-1",
  "0x12": "HDMI-2"
}

function defaultNameFor(code) {
  return MCCS_INPUT_NAMES[code] || ("Input " + code)
}

// ddcutil and hand-edited configs disagree on case and prefix ("0x0F", "x0f",
// "sl=0x13"). Fold all of them to a single lowercase "0x.." form so equality
// comparisons elsewhere are plain string compares.
function normalizeCode(raw) {
  if (raw === undefined || raw === null) return ""
  var s = String(raw).trim().toLowerCase()
  if (s === "") return ""
  s = s.replace(/^sl=/, "")
  s = s.replace(/^0x/, "").replace(/^x/, "")
  if (!/^[0-9a-f]+$/.test(s)) return ""
  if (s.length < 2) s = "0" + s
  return "0x" + s
}

// Config schema: { "inputs": [ { code, name, hidden? } ] }. The config is now
// purely an overlay — renames, ordering, and hiding on top of what the monitor
// reports — so missing or malformed JSON yields nothing rather than a guess.
// Discovery covers the empty case.
function parseConfig(text) {
  if (!text || String(text).trim() === "") return []
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return []
  }
  if (!parsed || !Array.isArray(parsed.inputs)) return []

  var out = []
  for (var i = 0; i < parsed.inputs.length; i++) {
    var entry = parsed.inputs[i]
    if (!entry) continue
    var code = normalizeCode(entry.code)
    if (code === "") continue
    out.push({
      code: code,
      name: entry.name ? String(entry.name) : defaultNameFor(code),
      hidden: entry.hidden === true
    })
  }
  return out
}

// Distinguishes "no config yet" from "config is broken" so the panel can say
// so — parseConfig returns [] for both, and silently ignoring a typo is how
// you get a user staring at names they didn't write.
function configIsMalformed(text) {
  if (!text || String(text).trim() === "") return false
  try {
    var parsed = JSON.parse(text)
    return !parsed || !Array.isArray(parsed.inputs)
  } catch (e) {
    return true
  }
}

function visibleInputs(inputs) {
  return (inputs || []).filter(function(entry) { return !entry.hidden })
}

// `ddcutil getvcp 60 --terse` prints "VCP 60 SNC x13". Older/plain output is
// "VCP code 0x60 (Input Source): DisplayPort-1 (sl=0x0f)", and on codes ddcutil
// doesn't recognize, "Invalid value (sl=0x13)". Accept all three shapes.
function parseCurrentCode(stdout) {
  if (!stdout) return ""
  var text = String(stdout)

  var sl = text.match(/sl=0x([0-9a-fA-F]+)/)
  if (sl) return normalizeCode(sl[1])

  var terse = text.match(/^\s*VCP\s+60\s+\S+\s+x([0-9a-fA-F]+)/m)
  if (terse) return normalizeCode(terse[1])

  return ""
}

// Ask the monitor which inputs it actually has, from `ddcutil capabilities`.
//
// Two shapes are accepted. The raw capabilities string — "…vcp(… 52 60( 19 0F
// 13 11 12) 62(0080) …)" — is the primary target: it is plain ASCII and comes
// out of `--terse` on every ddcutil that supports the flag. The pretty-printed
// "Feature: 60 (Input Source)" block is the fallback, and is deliberately
// second: monitors that return junk in a neighbouring feature (the U5226KW
// emits raw bytes for 0x62) make the whole pretty output non-UTF-8.
//
// Returns normalized codes in the order the monitor listed them.
function parseCapabilities(text) {
  if (!text) return []
  var body = String(text)

  // Feature ids are space- or paren-delimited inside vcp(...), and values are
  // bare hex with no parens of their own, so "60(" only ever starts a feature.
  // Falls through on an empty result rather than returning it: in the pretty
  // output this same pattern matches the header "Feature: 60 (Input Source)"
  // and captures prose, not codes.
  var raw = body.match(/(?:^|[\s(])60\s*\(([^)]*)\)/)
  if (raw) {
    var rawCodes = codeListFrom(raw[1])
    if (rawCodes.length > 0) return rawCodes
  }

  var lines = body.split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (!/^\s*Feature:\s*60\b/i.test(lines[i])) continue
    var collected = []
    for (var j = i + 1; j < lines.length; j++) {
      if (/^\s*Feature:/i.test(lines[j])) break
      var value = lines[j].match(/^\s*([0-9a-fA-F]{1,2})\s*:/)
      if (value) collected.push(value[1])
    }
    return codeListFrom(collected.join(" "))
  }

  return []
}

function codeListFrom(blob) {
  var out = []
  var tokens = String(blob).trim().split(/\s+/)
  for (var i = 0; i < tokens.length; i++) {
    var code = normalizeCode(tokens[i])
    if (code !== "" && out.indexOf(code) === -1) out.push(code)
  }
  return out
}

// Fold the monitor's own input list together with the user's overlay.
//
// Config wins on naming, ordering, and hiding; the monitor wins on what
// exists. Codes the user listed but the monitor never reported are kept rather
// than dropped — capability strings are known to under-report — but flagged
// `unsupported` so the panel can dim them instead of offering a row that
// silently does nothing. That flag is only meaningful once discovery has
// actually succeeded, hence `discovered.length` gating it.
function mergeInputs(discovered, configured) {
  var found = discovered || []
  var overlay = configured || []
  var seen = {}
  var out = []

  for (var i = 0; i < overlay.length; i++) {
    var entry = overlay[i]
    if (seen[entry.code]) continue
    seen[entry.code] = true
    out.push({
      code: entry.code,
      name: entry.name,
      hidden: entry.hidden === true,
      unsupported: found.length > 0 && found.indexOf(entry.code) === -1
    })
  }

  for (var j = 0; j < found.length; j++) {
    if (seen[found[j]]) continue
    seen[found[j]] = true
    out.push({
      code: found[j],
      name: defaultNameFor(found[j]),
      hidden: false,
      unsupported: false
    })
  }

  return out
}

function labelFor(inputs, code) {
  var wanted = normalizeCode(code)
  if (wanted === "") return ""
  var all = inputs || []
  for (var i = 0; i < all.length; i++) {
    if (all[i].code === wanted) return all[i].name
  }
  return "Unmapped " + wanted
}

// Build the argv for a ddcutil call. displayNumber 0 means "let ddcutil pick",
// which is right for the single-monitor case and wrong the moment there are two.
function ddcutilArgs(displayNumber, rest) {
  var args = ["ddcutil"]
  if (displayNumber > 0) args.push("--display", String(displayNumber))
  return args.concat(rest)
}

// Render a config file from a merged input list. Used to seed a first config
// from whatever the monitor reported, so the user opens a filled-in file and
// only has to replace names — never has to look up their monitor's codes.
function seedConfigJson(inputs) {
  var entries = (inputs || []).map(function(entry) {
    return '    { "code": "' + entry.code + '", "name": "'
      + String(entry.name).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" }'
  })
  return '{\n  "inputs": [\n' + entries.join(",\n") + '\n  ]\n}\n'
}

// Everything up to the last separator. QML has no path helpers and the config
// directory may not exist yet, so the panel has to mkdir before it can write.
function parentDir(path) {
  var s = String(path || "")
  var cut = s.lastIndexOf("/")
  return cut <= 0 ? "/" : s.slice(0, cut)
}

// Wrap-around cursor movement over the visible rows.
function moveIndex(current, delta, count) {
  if (count <= 0) return 0
  var next = current + delta
  while (next < 0) next += count
  return next % count
}
