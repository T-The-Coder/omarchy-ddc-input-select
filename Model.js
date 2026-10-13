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

// Config schema: { "inputs": [ { code, name, hidden?, bind?, override? } ] }. The config is now
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
      hidden: entry.hidden === true,
      bind: normalizeBind(entry.bind),
      override: entry.override === true
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
      bind: entry.bind || "",
      override: entry.override === true,
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
      bind: "",
      override: false,
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

// Find the input an IPC caller means, by code ("0x11", "x11", "11") or by
// name, case-insensitively. Codes win so a name that happens to look like hex
// can't shadow a real code. The MCCS names ("HDMI-1") always resolve too:
// shortcuts fire before the popup has ever opened, so discovery may not have
// run yet. Returns the normalized code, or "".
function resolveInput(inputs, wanted) {
  var all = inputs || []
  var code = normalizeCode(wanted)
  if (code !== "") {
    for (var i = 0; i < all.length; i++) {
      if (all[i].code === code) return code
    }
  }
  var name = String(wanted === undefined || wanted === null ? "" : wanted).trim().toLowerCase()
  if (name === "") return ""
  for (var j = 0; j < all.length; j++) {
    if (String(all[j].name).toLowerCase() === name) return all[j].code
  }
  for (var known in MCCS_INPUT_NAMES) {
    if (MCCS_INPUT_NAMES[known].toLowerCase() === name) return known
  }
  return ""
}

// Build the argv for a ddcutil call. displayNumber 0 means "let ddcutil pick",
// which is right for the single-monitor case and wrong the moment there are two.
// busNumber, when set, wins: behind a USB-C dock the DDC channel often only
// answers on the direct connection, and the I2C bus is the one stable handle
// for it.
function ddcutilArgs(displayNumber, rest, busNumber) {
  var args = ["ddcutil"]
  if (busNumber > 0) args.push("--bus", String(busNumber))
  else if (displayNumber > 0) args.push("--display", String(displayNumber))
  return args.concat(rest)
}

// Hyprland key specs as Omarchy's o.bind() takes them: "SHIFT + CTRL + 1".
// Only whitespace is tidied; anything else is passed through so Hyprland's own
// config errors stay the single source of truth on what is a valid key.
function normalizeBind(raw) {
  if (raw === undefined || raw === null) return ""
  return String(raw).replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim()
}

function luaString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ") + '"'
}

// While the shortcut editor listens for a key, Hyprland is switched into this
// submap. It holds no bindings but the way out, so every other shortcut is
// suspended and the combination being recorded reaches the popup — including
// one that is bound right now. CTRL + ALT + SHIFT + F12 leaves it should the
// shell go away mid-recording; the panel also leaves it on its own after a
// timeout. Not Escape: Hyprland 0.56 doesn't resolve that key name here and
// binds the modifiers to every key instead, so SUPER + anything would leave.
var RECORD_SUBMAP = "ddc-input-select-record"

function recordSubmapLua() {
  return "hl.define_submap(" + luaString(RECORD_SUBMAP)
    + ", function() hl.bind(\"CTRL + ALT + SHIFT + F12\", hl.dsp.submap(\"reset\")) end)"
}

// Shell command that enters the record submap, defining it first if this
// Hyprland session doesn't know it yet (no generated module loaded, or a
// reload since). Defining it unconditionally would stack a duplicate exit
// binding on every recording.
function enterRecordSubmapCommand() {
  var enter = "hyprctl dispatch " + shellQuote("hl.dsp.submap(" + luaString(RECORD_SUBMAP) + ")")
  return enter + " >/dev/null || { hyprctl eval " + shellQuote(recordSubmapLua())
    + " >/dev/null && " + enter + " >/dev/null; }"
}

function leaveRecordSubmapArgs() {
  return ["hyprctl", "dispatch", "hl.dsp.submap(\"reset\")"]
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// Render the plugin-owned Hyprland module from the configured inputs. Every
// input with a `bind` gets one o.bind() that switches to it over this
// plugin's IPC, so the widget's notion of the current input stays in sync and
// all DDC traffic goes through the one serialized Process. Hidden inputs keep
// their binding: hiding is about the popup list, and a shortcut is something
// the user wrote on purpose. `override` unbinds whatever else holds the
// combination first; that only wins over bindings defined before the module
// is required, which is why the require goes at the end of bindings.lua.
function bindingsLua(inputs, ipcTarget) {
  var lines = [
    "-- Generated by the Monitor Input plugin (ddc-input-select) from",
    "-- the \"bind\" fields in its inputs.json. Edits here are overwritten.",
    "-- Load it once, at the end of ~/.config/hypr/bindings.lua, with:",
    "--   require(\"hypr.ddc-input-select\")",
    recordSubmapLua()
  ]
  var count = 0
  var all = inputs || []
  for (var i = 0; i < all.length; i++) {
    if (!all[i].bind) continue
    if (all[i].override) lines.push("hl.unbind(" + luaString(all[i].bind) + ")")
    lines.push("o.bind(" + luaString(all[i].bind) + ", "
      + luaString(describeBind(all[i].name)) + ", "
      + luaString("omarchy-shell -q " + ipcTarget + " set " + all[i].code) + ")")
    count++
  }
  if (count === 0) lines.push("-- No shortcuts configured.")
  return lines.join("\n") + "\n"
}

function hasBindings(inputs) {
  return (inputs || []).some(function(entry) { return !!entry.bind })
}

// --- shortcut editor ---------------------------------------------------------
//
// The popup edits a bind as modifier toggles plus one key. Modifiers are
// toggles rather than recorded because Hyprland consumes any combination that
// is already bound before the popup ever sees it — and the input's current
// shortcut is exactly such a combination. A bare key press reaches the popup.

var MODIFIERS = ["SUPER", "CTRL", "ALT", "SHIFT"]
var MODMASK = { "SHIFT": 1, "CTRL": 4, "ALT": 8, "SUPER": 64 }
var MODIFIER_ALIASES = {
  "SUPER": "SUPER", "MOD4": "SUPER", "WIN": "SUPER", "LOGO": "SUPER", "META": "SUPER",
  "CTRL": "CTRL", "CONTROL": "CTRL",
  "ALT": "ALT", "MOD1": "ALT",
  "SHIFT": "SHIFT"
}

// "SHIFT + CTRL + 1" -> { mods: ["CTRL", "SHIFT"], key: "1" }. Modifiers come
// back in MODIFIERS order so two spellings of one shortcut compare equal.
function parseBind(bind) {
  var tokens = normalizeBind(bind).split("+")
  var mods = []
  var key = ""
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i].trim()
    if (token === "") continue
    var mod = MODIFIER_ALIASES[token.toUpperCase()]
    if (mod) { if (mods.indexOf(mod) === -1) mods.push(mod) }
    else key = token.toUpperCase()
  }
  mods.sort(function(a, b) { return MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b) })
  return { mods: mods, key: key }
}

function formatBind(mods, key) {
  var ordered = MODIFIERS.filter(function(mod) { return (mods || []).indexOf(mod) !== -1 })
  if (key) ordered.push(String(key).toUpperCase())
  return ordered.join(" + ")
}

function canonicalBind(bind) {
  var parsed = parseBind(bind)
  return parsed.key === "" ? "" : formatBind(parsed.mods, parsed.key)
}

// Qt key codes, spelled out because Model.js stays free of QML types.
var QT_KEYS = {
  0x20: "SPACE", 0x27: "APOSTROPHE", 0x2c: "COMMA", 0x2d: "MINUS", 0x2e: "PERIOD",
  0x2f: "SLASH", 0x3b: "SEMICOLON", 0x3d: "EQUAL", 0x5b: "BRACKETLEFT",
  0x5c: "BACKSLASH", 0x5d: "BRACKETRIGHT", 0x60: "GRAVE",
  0x01000004: "RETURN", 0x01000005: "RETURN", 0x01000006: "INSERT",
  0x01000009: "PRINT", 0x01000010: "HOME", 0x01000011: "END",
  0x01000012: "LEFT", 0x01000013: "UP", 0x01000014: "RIGHT", 0x01000015: "DOWN",
  0x01000016: "PRIOR", 0x01000017: "NEXT"
}

// Hyprland key name for a key press in the popup, or "" if it can't be bound.
// The number row is read from the scan code: with Shift held, or on layouts
// such as AZERTY, Qt reports the symbol on the key rather than the digit,
// while Hyprland binds "1" by the key itself. xkb keycodes 10..19 are 1..0.
function keyNameFor(qtKey, scanCode) {
  if (scanCode >= 10 && scanCode <= 19) return String((scanCode - 9) % 10)
  if (qtKey >= 0x30 && qtKey <= 0x39) return String.fromCharCode(qtKey)
  if (qtKey >= 0x41 && qtKey <= 0x5a) return String.fromCharCode(qtKey)
  if (qtKey >= 0x01000030 && qtKey <= 0x01000052) return "F" + (qtKey - 0x01000030 + 1)
  return QT_KEYS[qtKey] || ""
}

function modsFromMask(mask) {
  var out = []
  for (var i = 0; i < MODIFIERS.length; i++) {
    if (mask & MODMASK[MODIFIERS[i]]) out.push(MODIFIERS[i])
  }
  return out
}

// What else already answers to this shortcut, from `hyprctl binds -j`.
// `ownDescription` is the description this input's own bind gets, so the
// shortcut being edited — whether from our module or hand-written with the
// same wording — doesn't count as a clash with itself.
function hyprConflicts(bindsJson, bind, ownDescription) {
  var wanted = canonicalBind(bind)
  if (wanted === "") return []
  var list
  try { list = JSON.parse(bindsJson) } catch (e) { return [] }
  if (!Array.isArray(list)) return []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (!entry || entry.mouse || entry.submap) continue
    // Other inputs' shortcuts are inputConflicts' business, with a better
    // remedy (take it over) than unbinding.
    if (String(entry.description || "").indexOf("Monitor input: ") === 0) continue
    if (formatBind(modsFromMask(entry.modmask || 0), entry.key) !== wanted) continue
    var label = entry.description || (entry.dispatcher + " " + (entry.arg || "")).trim()
    if (label === ownDescription) continue
    if (out.indexOf(label) === -1) out.push(label)
  }
  return out
}

// Other configured inputs that already use this shortcut, as { code, name }.
function inputConflicts(inputs, code, bind) {
  var wanted = canonicalBind(bind)
  if (wanted === "") return []
  return (inputs || []).filter(function(entry) {
    return entry.code !== code && entry.bind && canonicalBind(entry.bind) === wanted
  }).map(function(entry) { return { code: entry.code, name: entry.name } })
}

function describeBind(name) {
  return "Monitor input: " + name
}

// Write one input's bind into the config text, keeping everything else the
// user wrote: other entries, their order, unknown keys. An input that isn't
// in the config yet is appended under the name the popup shows. An empty
// bind removes the field. `override` marks the bind as taking the combination
// from other Hyprland bindings; `takeFrom` lists inputs whose bind is dropped
// because this one takes it over. Returns "" if the existing text isn't a
// config this can safely rewrite — never guess over a file the user is
// mid-way through.
function configWithBind(text, code, name, bind, override, takeFrom) {
  var parsed = { inputs: [] }
  if (text && String(text).trim() !== "") {
    try { parsed = JSON.parse(text) } catch (e) { return "" }
    if (!parsed || !Array.isArray(parsed.inputs)) return ""
  }
  var wanted = normalizeCode(code)
  var found = false
  for (var i = 0; i < parsed.inputs.length; i++) {
    var entry = parsed.inputs[i]
    if (!entry) continue
    var entryCode = normalizeCode(entry.code)
    if ((takeFrom || []).indexOf(entryCode) !== -1 && entryCode !== wanted) {
      delete entry.bind
      delete entry.override
      continue
    }
    if (entryCode !== wanted) continue
    found = true
    if (bind) entry.bind = bind
    else delete entry.bind
    if (bind && override) entry.override = true
    else delete entry.override
  }
  if (!found && bind) {
    var added = { code: wanted, name: name, bind: bind }
    if (override) added.override = true
    parsed.inputs.push(added)
  }
  return renderConfig(parsed)
}

// One input per line, like the seed, so a file the popup touched still reads
// like one a person wrote.
function renderConfig(parsed) {
  var entries = parsed.inputs.map(function(entry) {
    if (!entry || typeof entry !== "object") return "    " + JSON.stringify(entry)
    return "    { " + Object.keys(entry).map(function(key) {
      return JSON.stringify(key) + ": " + JSON.stringify(entry[key])
    }).join(", ") + " }"
  })
  var lines = ["{"]
  var keys = Object.keys(parsed)
  for (var k = 0; k < keys.length; k++) {
    var last = k === keys.length - 1 ? "" : ","
    if (keys[k] === "inputs") {
      lines.push('  "inputs": [')
      if (entries.length > 0) lines.push(entries.join(",\n"))
      lines.push("  ]" + last)
    } else {
      lines.push("  " + JSON.stringify(keys[k]) + ": " + JSON.stringify(parsed[keys[k]]) + last)
    }
  }
  lines.push("}")
  return lines.join("\n") + "\n"
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
