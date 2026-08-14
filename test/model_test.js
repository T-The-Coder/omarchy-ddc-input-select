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
  "defaultNameFor", "ddcutilArgs", "moveIndex", "seedConfigJson", "parentDir"
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

// --- misc -----------------------------------------------------------------
eq(M.labelFor(M.mergeInputs(discovered, configured), "0x13"), "Twilight", "labelFor")
eq(M.labelFor([], "0x99"), "Unmapped 0x99", "labelFor unmapped")
eq(M.ddcutilArgs(0, ["getvcp", "60"]), ["ddcutil", "getvcp", "60"],
   "args: no display flag when 0")
eq(M.ddcutilArgs(2, ["setvcp", "10", "+", "10"]),
   ["ddcutil", "--display", "2", "setvcp", "10", "+", "10"], "args: display flag")
eq(M.moveIndex(0, -1, 5), 4, "cursor wraps up")
eq(M.moveIndex(4, 1, 5), 0, "cursor wraps down")
eq(M.moveIndex(0, 1, 0), 0, "cursor handles empty list")

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
