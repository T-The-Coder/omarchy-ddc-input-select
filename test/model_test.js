// Unit tests for Model.js. Run with `make test-model` (needs node).
//
// Model.js is written for QML's JS engine, so it has no module system — it is
// loaded here by wrapping it in a function and exporting the names we assert on.

const fs = require("fs")
const path = require("path")

const SRC = path.join(__dirname, "..", "Model.js")
const EXPORTS = [
  "normalizeCode", "parseConfig", "configIsMalformed", "visibleInputs",
  "parseCurrentCode", "parseCapabilities", "mergeInputs", "labelFor",
  "defaultNameFor", "ddcutilArgs", "moveIndex", "seedConfigJson", "parentDir",
  "resolveInput", "normalizeBind", "bindingsLua", "hasBindings",
  "parseBind", "formatBind", "canonicalBind", "keyNameFor", "modsFromMask",
  "hyprConflicts", "inputConflicts", "configWithBind", "enterRecordSubmapCommand",
  "leaveRecordSubmapArgs", "shellQuote"
]

const M = {}
new Function("exports",
  fs.readFileSync(SRC, "utf8") + "\n" +
  EXPORTS.map(n => `exports.${n} = ${n};`).join("\n")
)(M)

let failures = 0
function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log("ok   " + name)
  } else {
    failures++
    console.log("FAIL " + name + "\n       got  " + a + "\n       want " + b)
  }
}

// --- code normalization ---------------------------------------------------
eq(M.normalizeCode("0x0F"), "0x0f", "normalize uppercase 0x form")
eq(M.normalizeCode("sl=0x13"), "0x13", "normalize ddcutil sl= form")
eq(M.normalizeCode("x13"), "0x13", "normalize terse x form")
eq(M.normalizeCode("9"), "0x09", "normalize pads to two digits")
eq(M.normalizeCode("zz"), "", "normalize rejects non-hex")
eq(M.normalizeCode(null), "", "normalize handles null")

// --- current input --------------------------------------------------------
eq(M.parseCurrentCode("VCP 60 SNC x13"), "0x13", "getvcp --terse")
eq(M.parseCurrentCode("VCP code 0x60 (Input Source): Invalid value (sl=0x19)"),
   "0x19", "getvcp plain, vendor code")
eq(M.parseCurrentCode("VCP code 0x60 (Input Source): DisplayPort-1 (sl=0x0f)"),
   "0x0f", "getvcp plain, named code")
eq(M.parseCurrentCode(""), "", "getvcp empty")

// --- capability discovery -------------------------------------------------
// Verbatim from `ddcutil capabilities --terse` on a Dell U5226KW, trimmed.
const U5226KW_TERSE =
  "Unparsed capabilities string: (prot(monitor)type(lcd)model(U5226KW)" +
  "cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 10 12 14(01 04 05 06 08 09 0B 0C) " +
  "16 18 1A 52 60( 19 0F 13 11 12) 62(0080) 63(F1 F2 F3 F4) 66(00D2) 87 8D AC " +
  "AE B2 B6 C6(01) C8 C9 CA CC(02 03 04 06 09 0A 0D 0E) D6(01 04 05) DC(00 03 05) " +
  "DF E0(03) E2(00 02 04 0C 0D 0F 10 11 13 0B 1B 1A 3D 14) E5 E7(00 01 02 03 FE FF)" +
  ")mccs_ver(2.1)mswhql(1))"

eq(M.parseCapabilities(U5226KW_TERSE), ["0x19", "0x0f", "0x13", "0x11", "0x12"],
   "capabilities: raw string, monitor order preserved")

// A monitor with no vendor extensions and no value list on 0x60.
eq(M.parseCapabilities("(prot(monitor)vcp(10 12 60(0F 11) DF))"),
   ["0x0f", "0x11"], "capabilities: plain two-input monitor")

// The pretty-printed fallback, for ddcutil builds where --terse differs.
const PRETTY = [
  "VCP Features:",
  "   Feature: 52 (Active control)",
  "   Feature: 60 (Input Source)",
  "      Values:",
  "         19: Unrecognized value",
  "         0f: DisplayPort-1",
  "         11: HDMI-1",
  "   Feature: 62 (Audio speaker volume)",
  "      Values:",
  "         01: something else"
].join("\n")
eq(M.parseCapabilities(PRETTY), ["0x19", "0x0f", "0x11"],
   "capabilities: pretty block stops at next feature")

eq(M.parseCapabilities("no vcp data here"), [], "capabilities: nothing to find")
eq(M.parseCapabilities(""), [], "capabilities: empty input")
// 0x60 must not be picked up from another feature's value list.
eq(M.parseCapabilities("(vcp(14(60 61) 60(0F)))"), ["0x0f"],
   "capabilities: value 60 in another feature is not a match")

// --- config ---------------------------------------------------------------
eq(M.parseConfig(""), [], "config: absent yields nothing, not a guess")
eq(M.parseConfig("{bad"), [], "config: malformed yields nothing")
eq(M.configIsMalformed("{bad"), true, "config: malformed is reported")
eq(M.configIsMalformed(""), false, "config: absent is not malformed")
eq(M.configIsMalformed('{"inputs":[]}'), false, "config: valid is not malformed")
eq(M.parseConfig('{"inputs":[{"code":"0x13"}]}')[0].name, "Input 0x13",
   "config: unnamed vendor code falls back to its number")
eq(M.parseConfig('{"inputs":[{"code":"0x11"}]}')[0].name, "HDMI-1",
   "config: unnamed standard code gets its MCCS name")

// --- merge ----------------------------------------------------------------
const discovered = ["0x19", "0x0f", "0x13", "0x11", "0x12"]
const configured = M.parseConfig(JSON.stringify({
  inputs: [
    { code: "0x13", name: "Twilight" },
    { code: "0x12", name: "HDMI 2", hidden: true }
  ]
}))

eq(M.mergeInputs(discovered, configured).map(e => e.code),
   ["0x13", "0x12", "0x19", "0x0f", "0x11"],
   "merge: config order first, undeclared discoveries appended")
eq(M.mergeInputs(discovered, configured).map(e => e.name),
   ["Twilight", "HDMI 2", "Input 0x19", "DisplayPort-1", "HDMI-1"],
   "merge: config names win, rest named from the monitor")
eq(M.visibleInputs(M.mergeInputs(discovered, configured)).map(e => e.code),
   ["0x13", "0x19", "0x0f", "0x11"], "merge: hidden still filtered")
eq(M.mergeInputs(discovered, configured).every(e => !e.unsupported), true,
   "merge: everything discovered is supported")

// A stale config entry survives, but is flagged rather than silently inert.
const stale = M.parseConfig('{"inputs":[{"code":"0x99","name":"Old Dock"}]}')
eq(M.mergeInputs(discovered, stale)[0].unsupported, true,
   "merge: config code the monitor never reported is flagged")
eq(M.mergeInputs([], stale)[0].unsupported, false,
   "merge: nothing is flagged when discovery failed entirely")
eq(M.mergeInputs([], []), [], "merge: no config and no discovery is empty")
eq(M.mergeInputs(discovered, []).map(e => e.name),
   ["Input 0x19", "DisplayPort-1", "Input 0x13", "HDMI-1", "HDMI-2"],
   "merge: config-free install is driven entirely by the monitor")

// --- seeding a first config -----------------------------------------------
// The seed is what the "Name these inputs" button writes before opening the
// editor, so it has to survive being read straight back by parseConfig.
const seeded = M.seedConfigJson(M.mergeInputs(discovered, []))
eq(M.parseConfig(seeded).map(e => e.code), discovered,
   "seed: round-trips through parseConfig with codes intact")
eq(M.configIsMalformed(seeded), false, "seed: is valid JSON")
eq(M.parseConfig(M.seedConfigJson([{ code: "0x11", name: 'He said "hi"\\' }]))[0].name,
   'He said "hi"\\', "seed: quotes and backslashes in a name are escaped")
eq(M.seedConfigJson([]), '{\n  "inputs": [\n\n  ]\n}\n', "seed: empty list is still valid")

eq(M.parentDir("/home/u/.config/ddc-input-select/inputs.json"),
   "/home/u/.config/ddc-input-select", "parentDir: normal path")
eq(M.parentDir("/inputs.json"), "/", "parentDir: root")
eq(M.parentDir("inputs.json"), "/", "parentDir: bare filename")

// The cursor space is rows + 1: the last stop is the edit control.
eq(M.moveIndex(4, 1, 6), 5, "cursor: steps onto the edit control")
eq(M.moveIndex(5, 1, 6), 0, "cursor: wraps from the edit control to the first row")

// --- per-input shortcuts ---------------------------------------------------
const bound = M.parseConfig(JSON.stringify({
  inputs: [
    { code: "0x01", name: "VGA", bind: "SHIFT + CTRL + 1" },
    { code: "0x0f", name: "DisplayPort", bind: "  SHIFT +  CTRL\n+ 2 " },
    { code: "0x11", name: 'Work "Laptop"', bind: "SHIFT + CTRL + 3", hidden: true },
    { code: "0x12", name: "HDMI 2" }
  ]
}))
eq(bound.map(e => e.bind), ["SHIFT + CTRL + 1", "SHIFT + CTRL + 2", "SHIFT + CTRL + 3", ""],
   "bind: parsed, whitespace tidied, absent is empty")
eq(M.mergeInputs(["0x01", "0x0f"], bound)[0].bind, "SHIFT + CTRL + 1",
   "bind: survives the merge")
eq(M.mergeInputs(["0x13"], [])[0].bind, "", "bind: discovered-only input has none")
eq(M.hasBindings(bound), true, "bind: hasBindings with binds")
eq(M.hasBindings(M.parseConfig('{"inputs":[{"code":"0x11"}]}')), false,
   "bind: hasBindings without binds")
eq(M.normalizeBind(null), "", "bind: null is empty")

const lua = M.bindingsLua(bound, "ddc-input")
eq(lua.split("\n").filter(l => l.startsWith("o.bind(")), [
  'o.bind("SHIFT + CTRL + 1", "Monitor input: VGA", "omarchy-shell -q ddc-input set 0x01")',
  'o.bind("SHIFT + CTRL + 2", "Monitor input: DisplayPort", "omarchy-shell -q ddc-input set 0x0f")',
  'o.bind("SHIFT + CTRL + 3", "Monitor input: Work \\"Laptop\\"", "omarchy-shell -q ddc-input set 0x11")'
], "lua: one bind per bound input, hidden included, quotes escaped")
eq(lua.endsWith("\n"), true, "lua: ends with a newline")
eq(M.bindingsLua([], "ddc-input").includes("-- No shortcuts configured."), true,
   "lua: empty list still renders a valid module")
eq(M.bindingsLua([], "ddc-input").includes("o.bind("), false, "lua: empty list binds nothing")
eq(M.bindingsLua([], "ddc-input").includes('hl.define_submap("ddc-input-select-record"'), true,
   "lua: defines the record submap")
const overriding = M.parseConfig('{"inputs":[{"code":"0x11","name":"HDMI","bind":"SUPER + W","override":true}]}')
eq(overriding[0].override, true, "override: parsed")
eq(M.mergeInputs(["0x11"], overriding)[0].override, true, "override: survives the merge")
eq(M.bindingsLua(overriding, "ddc-input").split("\n").filter(l => /^(hl\.unbind|o\.bind)/.test(l)), [
  'hl.unbind("SUPER + W")',
  'o.bind("SUPER + W", "Monitor input: HDMI", "omarchy-shell -q ddc-input set 0x11")'
], "override: unbinds the combination before binding it")

eq(M.shellQuote("it's"), "'it'\\''s'", "shellQuote: single quote")
eq(M.enterRecordSubmapCommand(),
   "hyprctl dispatch 'hl.dsp.submap(\"ddc-input-select-record\")' >/dev/null || "
   + "{ hyprctl eval 'hl.define_submap(\"ddc-input-select-record\", function() "
   + "hl.bind(\"CTRL + ALT + SHIFT + F12\", hl.dsp.submap(\"reset\")) end)' >/dev/null && "
   + "hyprctl dispatch 'hl.dsp.submap(\"ddc-input-select-record\")' >/dev/null; }",
   "submap: enter, defining it only when missing")
eq(M.leaveRecordSubmapArgs(), ["hyprctl", "dispatch", 'hl.dsp.submap("reset")'], "submap: leave")

eq(M.resolveInput(bound, "0x0F"), "0x0f", "resolve: by code, any case")
eq(M.resolveInput(bound, "11"), "0x11", "resolve: bare hex code")
eq(M.resolveInput(bound, "displayport"), "0x0f", "resolve: by name, case-insensitive")
eq(M.resolveInput(bound, "Nope"), "", "resolve: unknown name")
eq(M.resolveInput([], "hdmi-1"), "0x11", "resolve: MCCS name works before discovery")
eq(M.resolveInput([], "0x11"), "", "resolve: unknown code is left to the caller")
eq(M.resolveInput(bound, ""), "", "resolve: empty")
eq(M.resolveInput([{ code: "0x0a", name: "12" }, { code: "0x12", name: "x" }], "12"), "0x12",
   "resolve: a code wins over a name that looks like one")

// --- shortcut editor -------------------------------------------------------
eq(M.parseBind("SHIFT + CTRL + 1"), { mods: ["CTRL", "SHIFT"], key: "1" },
   "editor: parse orders modifiers")
eq(M.parseBind("control+mod4+h"), { mods: ["SUPER", "CTRL"], key: "H" },
   "editor: parse aliases and lowercase")
eq(M.parseBind(""), { mods: [], key: "" }, "editor: parse empty")
eq(M.formatBind(["SHIFT", "CTRL"], "1"), "CTRL + SHIFT + 1", "editor: format in fixed order")
eq(M.formatBind(["SUPER"], ""), "SUPER", "editor: format without key")
eq(M.canonicalBind("SHIFT + CTRL + 1"), M.canonicalBind("ctrl + shift + 1"),
   "editor: two spellings, one shortcut")
eq(M.canonicalBind("SHIFT"), "", "editor: modifiers alone are no shortcut")

eq(M.keyNameFor(0x21, 10), "1", "key: Shift+1 reads the digit from the scan code")
eq(M.keyNameFor(0x26, 19), "0", "key: scan code 19 is 0")
eq(M.keyNameFor(0x33, 0), "3", "key: digit without scan code")
eq(M.keyNameFor(0x48, 43), "H", "key: letter")
eq(M.keyNameFor(0x01000030, 67), "F1", "key: F1")
eq(M.keyNameFor(0x01000004, 36), "RETURN", "key: named key")
eq(M.keyNameFor(0xdc, 34), "", "key: unknown is refused")

eq(M.modsFromMask(5), ["CTRL", "SHIFT"], "mask: 5 is CTRL+SHIFT")
eq(M.modsFromMask(64 | 8), ["SUPER", "ALT"], "mask: SUPER+ALT")

const HYPR_BINDS = JSON.stringify([
  { modmask: 5, key: "1", description: "Monitor input: VGA", dispatcher: "__lua", arg: "1", mouse: false, submap: "" },
  { modmask: 64, key: "RETURN", description: "Terminal", dispatcher: "__lua", arg: "2", mouse: false, submap: "" },
  { modmask: 64, key: "J", description: "", dispatcher: "togglesplit", arg: "", mouse: false, submap: "" },
  { modmask: 64, key: "mouse:272", description: "Move", dispatcher: "movewindow", arg: "", mouse: true, submap: "" },
  { modmask: 0, key: "escape", description: "Leave resize", dispatcher: "submap", arg: "reset", mouse: false, submap: "resize" }
])
eq(M.hyprConflicts(HYPR_BINDS, "SUPER + RETURN", "Monitor input: HDMI"), ["Terminal"],
   "conflict: taken by another binding")
eq(M.hyprConflicts(HYPR_BINDS, "CTRL + SHIFT + 1", "Monitor input: VGA"), [],
   "conflict: the input's own shortcut is not a clash")
eq(M.hyprConflicts(HYPR_BINDS, "SHIFT + CTRL + 1", "Monitor input: HDMI"), [],
   "conflict: other inputs' shortcuts are left to inputConflicts")
eq(M.hyprConflicts(HYPR_BINDS, "SUPER + J", "x"), ["togglesplit"],
   "conflict: undescribed binding falls back to its dispatcher")
eq(M.hyprConflicts(HYPR_BINDS, "ESCAPE", "x"), [], "conflict: submap bindings ignored")
eq(M.hyprConflicts("not json", "SUPER + J", "x"), [], "conflict: bad JSON is no conflict")
eq(M.inputConflicts(bound, "0x0f", "CTRL + SHIFT + 1"), [{ code: "0x01", name: "VGA" }],
   "conflict: between inputs")
eq(M.inputConflicts(bound, "0x01", "SHIFT + CTRL + 1"), [], "conflict: not with itself")

const userConfig = '{\n  "inputs": [\n    { "code": "0x0F", "name": "Dock", "hidden": false, "note": "mine" },\n    { "code": "0x11", "name": "HDMI", "bind": "SUPER + H" }\n  ],\n  "extra": 1\n}\n'
const withBind = M.configWithBind(userConfig, "0x0f", "Dock", "CTRL + SHIFT + 2")
eq(JSON.parse(withBind).inputs[0], { code: "0x0F", name: "Dock", hidden: false, note: "mine", bind: "CTRL + SHIFT + 2" },
   "write: bind added, other fields kept")
eq(JSON.parse(withBind).extra, 1, "write: unknown top-level keys kept")
eq(withBind.split("\n")[2], '    { "code": "0x0F", "name": "Dock", "hidden": false, "note": "mine", "bind": "CTRL + SHIFT + 2" },',
   "write: one input per line")
eq(JSON.parse(M.configWithBind(userConfig, "0x11", "HDMI", "")).inputs[1], { code: "0x11", name: "HDMI" },
   "write: empty bind removes the field")
eq(JSON.parse(M.configWithBind(userConfig, "0x01", "VGA-1", "CTRL + 1")).inputs[2],
   { code: "0x01", name: "VGA-1", bind: "CTRL + 1" }, "write: unlisted input is appended")
eq(JSON.parse(M.configWithBind("", "0x01", "VGA-1", "CTRL + 1")),
   { inputs: [{ code: "0x01", name: "VGA-1", bind: "CTRL + 1" }] }, "write: no config yet")
eq(M.configWithBind("{bad", "0x01", "VGA-1", "CTRL + 1"), "", "write: refuses a broken config")
eq(M.parseConfig(M.configWithBind("", "0x01", 'A "q"', "CTRL + 1"))[0].name, 'A "q"',
   "write: round-trips through parseConfig")
eq(JSON.parse(M.configWithBind('{"inputs":[]}', "0x01", "x", "")), { inputs: [] },
   "write: removing a bind that was never there changes nothing")
eq(JSON.parse(M.configWithBind(userConfig, "0x0f", "Dock", "SUPER + W", true)).inputs[0].override, true,
   "write: override is stored")
eq("override" in JSON.parse(M.configWithBind(
     M.configWithBind(userConfig, "0x0f", "Dock", "SUPER + W", true), "0x0f", "Dock", "SUPER + Q", false)).inputs[0],
   false, "write: a later save without override drops it")
eq(JSON.parse(M.configWithBind(userConfig, "0x0f", "Dock", "SUPER + H", false, ["0x11"])).inputs.map(e => e.bind),
   ["SUPER + H", undefined], "write: takeFrom drops the other input's bind")
eq(JSON.parse(M.configWithBind(userConfig, "0x01", "VGA", "CTRL + 1", true)).inputs[2],
   { code: "0x01", name: "VGA", bind: "CTRL + 1", override: true }, "write: appended input keeps override")

// --- misc -----------------------------------------------------------------
eq(M.labelFor(M.mergeInputs(discovered, configured), "0x13"), "Twilight", "labelFor")
eq(M.labelFor([], "0x99"), "Unmapped 0x99", "labelFor unmapped")
eq(M.ddcutilArgs(0, ["getvcp", "60"]), ["ddcutil", "getvcp", "60"],
   "args: no display flag when 0")
eq(M.ddcutilArgs(2, ["setvcp", "10", "+", "10"]),
   ["ddcutil", "--display", "2", "setvcp", "10", "+", "10"], "args: display flag")
eq(M.ddcutilArgs(2, ["getvcp", "60"], 3), ["ddcutil", "--bus", "3", "getvcp", "60"],
   "args: bus wins over display")
eq(M.ddcutilArgs(0, ["getvcp", "60"], 0), ["ddcutil", "getvcp", "60"],
   "args: bus 0 is off")
eq(M.moveIndex(0, -1, 5), 4, "cursor wraps up")
eq(M.moveIndex(4, 1, 5), 0, "cursor wraps down")
eq(M.moveIndex(0, 1, 0), 0, "cursor handles empty list")

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
