import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget + popup for switching a DDC/CI monitor's active input.
//
// One entry point serves both roles, matching the first-party panel plugins:
// the root Panel owns the open/close lifecycle, BarIconButton paints the bar
// slot, and KeyboardPanel hosts the popup.
//
// DDC reads and writes are slow (~1-3s round trip on the U5226KW) and the i2c
// bus tolerates exactly one conversation at a time, so every ddcutil call goes
// through an async Process guarded by a `running` check, and the current input
// is polled only when the panel opens — never on a background timer.
Panel {
  id: root

  moduleName: "io.github.mattflower.ddc-input-select"
  ipcTarget: "ddc-input"
  // manageIpc: false so this panel can own the single IpcHandler the target
  // permits — needed for the set method that per-input shortcuts call.
  manageIpc: false

  readonly property int displayNumber: setting("displayNumber", 0)
  readonly property int busNumber: setting("busNumber", 0)
  readonly property bool showLabel: setting("showLabel", false) === true
  readonly property string configPath: {
    var custom = String(setting("configPath", ""))
    if (custom !== "") return custom.replace(/^~/, Quickshell.env("HOME"))
    return Quickshell.env("HOME") + "/.config/ddc-input-select/inputs.json"
  }

  // What the user wrote (names, order, hidden flags) …
  property var configInputs: []
  property bool configBroken: false
  // … and what the monitor says it actually has. Discovery is authoritative
  // for existence; the config is an overlay on top of it.
  property var discovered: []
  property bool discoveryTried: false

  readonly property var inputs: Model.mergeInputs(discovered, configInputs)
  readonly property var rows: Model.visibleInputs(inputs)

  property string currentCode: ""
  property string errorText: ""
  property int cursorIndex: 0
  property bool cursorActive: false

  readonly property int brightnessStep: setting("brightnessStep", 10)
  readonly property bool busy: getProc.running || setProc.running
    || brightnessProc.running || capsProc.running
  readonly property string currentLabel: {
    if (currentCode === "") return busy ? "Reading…" : "Unknown"
    return Model.labelFor(inputs, currentCode)
  }

  readonly property string statusText: {
    if (setProc.running) return "SWITCHING…"
    if (capsProc.running) return "DETECTING INPUTS…"
    if (getProc.running && currentCode === "") return "READING…"
    return currentLabel.toUpperCase()
  }

  readonly property string emptyText: {
    if (!discoveryTried || busy) return ""
    if (rows.length > 0) return ""
    return "No inputs reported. Check that your user can reach /dev/i2c-* "
      + "(the i2c group and the i2c-dev module), then hit refresh."
  }

  readonly property color hoverFill: bar
    ? Style.hoverFillFor(bar.foreground, Color.accent)
    : Style.hoverFillFor(Color.foreground, Color.accent)
  readonly property color selectedFill: bar
    ? Style.selectedFillFor(bar.foreground, Color.accent)
    : Style.selectedFillFor(Color.foreground, Color.accent)

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The i2c bus takes one conversation at a time, so discovery and the current
  // -input read are chained rather than fired together: capabilities first
  // (~0.5s), then getvcp (~3s) from its onExited.
  function refresh() {
    if (busy) return
    capsProc.command = Model.ddcutilArgs(root.displayNumber, ["capabilities", "--terse"], root.busNumber)
    capsProc.running = true
  }

  function readCurrent() {
    if (getProc.running || setProc.running) return
    getProc.command = Model.ddcutilArgs(root.displayNumber, ["getvcp", "60", "--terse"], root.busNumber)
    getProc.running = true
  }

  // Returns a short status for IPC callers; the popup ignores it.
  function applyInput(code) {
    if (busy) return "busy"
    var normalized = Model.normalizeCode(code)
    if (normalized === "") return "unknown input"
    root.errorText = ""
    setProc.pendingCode = normalized
    setProc.command = Model.ddcutilArgs(root.displayNumber, ["setvcp", "60", normalized], root.busNumber)
    setProc.running = true
    return "ok"
  }

  // IPC entry point for per-input shortcuts: `omarchy-shell ddc-input set 0x11`
  // or `… set "Work Laptop"`. Codes the monitor never reported are still
  // accepted, matching what clicking a dimmed row does.
  function setIpc(wanted) {
    var code = Model.resolveInput(root.inputs, wanted)
    if (code === "") code = Model.normalizeCode(wanted)
    return root.applyInput(code)
  }

  // --- per-input shortcuts ---------------------------------------------------
  //
  // Each input's optional "bind" in inputs.json becomes one o.bind() line in a
  // file this plugin owns. The user's own bindings.lua is never written; it
  // only needs a one-time require. Nothing is created until a bind exists, so
  // installs that don't use shortcuts leave ~/.config/hypr untouched.
  readonly property string hyprDir: Quickshell.env("HOME") + "/.config/hypr"
  readonly property string bindingsPath: hyprDir + "/ddc-input-select.lua"
  readonly property bool hasBindings: Model.hasBindings(configInputs)
  property bool configSettled: false
  property bool bindingsSettled: false
  property bool bindingsExist: false
  property string bindingsText: ""
  property string hyprUserText: ""
  readonly property bool bindingsRequired: hyprUserText.indexOf("hypr.ddc-input-select") !== -1

  function syncBindings() {
    if (!configSettled || !bindingsSettled) return
    var wanted = Model.bindingsLua(configInputs, root.ipcTarget)
    if (!hasBindings && !bindingsExist) return
    if (bindingsExist && wanted === bindingsText) return
    bindingsFile.setText(wanted)
    root.bindingsText = wanted
    root.bindingsExist = true
    if (!reloadProc.running) reloadProc.running = true
  }

  // --- settings page -----------------------------------------------------------
  //
  // Replaces the input list in the same popup and lists every input, hidden
  // ones included. Picking one opens its editor: name, shortcut, and whether
  // it shows in the list. Saving writes those into inputs.json, which the
  // FileView above then turns into the popup's names and the Hyprland module.
  // Recording a shortcut switches Hyprland into an empty submap so that no
  // binding swallows the combination — the input's current shortcut included.
  property bool settingsOpen: false
  property string editCode: ""
  property string editName: ""
  property string editDraftName: ""
  property bool editHidden: false
  property string editOriginal: ""
  property bool editOriginalOverride: false
  property var editMods: []
  property string editKey: ""
  property bool recording: false
  property string recordError: ""
  property string hyprBindsText: ""

  readonly property bool editing: editCode !== ""
  readonly property string editBind: editKey === "" ? "" : Model.formatBind(editMods, editKey)
  readonly property var editHyprConflicts: editBind === "" ? []
    : Model.hyprConflicts(hyprBindsText, editBind, Model.describeBind(editName))
  readonly property var editInputConflicts: Model.inputConflicts(inputs, editCode, editBind)
  readonly property string editProblem: {
    if (editKey !== "" && editMods.length === 0) return "Hold at least one of Super, Ctrl, Alt or Shift, so the key keeps working everywhere else."
    return ""
  }
  readonly property bool editHasConflict: editProblem === "" && editBind !== ""
    && (editHyprConflicts.length > 0 || editInputConflicts.length > 0)
  readonly property string editConflictText: {
    var parts = []
    if (editInputConflicts.length > 0) {
      parts.push("Already the shortcut for " + editInputConflicts.map(function(c) { return c.name }).join(", ") + ".")
    }
    if (editHyprConflicts.length > 0) {
      parts.push("Hyprland uses it for: " + editHyprConflicts.join(", ") + ".")
    }
    return parts.join(" ")
  }

  function openEditor(entry) {
    root.editCode = entry.code
    root.editName = entry.name
    root.editDraftName = entry.name
    root.editHidden = entry.hidden === true
    root.editOriginal = entry.bind || ""
    root.editOriginalOverride = entry.override === true
    var parsed = Model.parseBind(entry.bind)
    root.editMods = parsed.mods
    root.editKey = parsed.key
    root.recordError = ""
    root.errorText = ""
    // Ask Hyprland once per edit what is already bound, for the clash warning.
    if (!bindsProc.running) bindsProc.running = true
  }

  function openSettings(open) {
    root.closeEditor()
    root.settingsOpen = open
    root.cursorActive = false
    root.cursorIndex = 0
  }

  function closeEditor() {
    root.recording = false
    recordTimeout.stop()
    root.releaseSubmap()
    root.editCode = ""
    keyCatcher.forceActiveFocus()
  }

  function startRecording() {
    root.recordError = ""
    root.recording = true
    recorder.forceActiveFocus()
    recordTimeout.restart()
    if (!root.submapHeld) {
      root.submapHeld = true
      submapLeaveQueued = false
      if (!submapEnterProc.running) submapEnterProc.running = true
    }
  }

  function stopRecording() {
    root.recording = false
    recordTimeout.stop()
    keyCatcher.forceActiveFocus()
    root.releaseSubmap()
  }

  // Leave the record submap. If entering is still in flight, leave right
  // after it lands rather than racing it.
  property bool submapHeld: false
  property bool submapLeaveQueued: false
  function releaseSubmap() {
    if (!root.submapHeld) return
    root.submapHeld = false
    if (submapEnterProc.running) { root.submapLeaveQueued = true; return }
    Quickshell.execDetached(Model.leaveRecordSubmapArgs())
  }

  // Never leave the user without their shortcuts for long, whatever happened
  // to the popup.
  Timer {
    id: recordTimeout
    interval: 20000
    onTriggered: if (root.recording) root.stopRecording()
  }

  Process {
    id: submapEnterProc
    command: ["sh", "-c", Model.enterRecordSubmapCommand()]
    onExited: {
      if (root.submapLeaveQueued || !root.submapHeld) {
        root.submapLeaveQueued = false
        Quickshell.execDetached(Model.leaveRecordSubmapArgs())
      }
    }
  }

  Component.onDestruction: if (submapHeld) Quickshell.execDetached(Model.leaveRecordSubmapArgs())

  // Bound to the recorder's Keys.onPressed while recording.
  function recordKey(event) {
    if (event.key === Qt.Key_Escape) { stopRecording(); return }
    if (event.key === Qt.Key_Backspace || event.key === Qt.Key_Delete) {
      root.editKey = ""
      stopRecording()
      return
    }
    // A modifier on its own is someone reaching for a combination; wait for
    // the key that completes it.
    if ([Qt.Key_Shift, Qt.Key_Control, Qt.Key_Alt, Qt.Key_Meta, Qt.Key_Super_L,
         Qt.Key_Super_R, Qt.Key_AltGr].indexOf(event.key) !== -1) return
    var name = Model.keyNameFor(event.key, event.nativeScanCode)
    if (name === "") {
      root.recordError = "That key can't be used here. Try a letter, digit or F-key."
      return
    }
    // The held modifiers are the combination.
    var held = []
    if (event.modifiers & Qt.ControlModifier) held.push("CTRL")
    if (event.modifiers & Qt.ShiftModifier) held.push("SHIFT")
    if (event.modifiers & Qt.AltModifier) held.push("ALT")
    if (event.modifiers & Qt.MetaModifier) held.push("SUPER")
    root.editMods = Model.parseBind(Model.formatBind(held, "")).mods
    root.editKey = name
    stopRecording()
  }

  // `override` takes the shortcut from whatever else holds it: other inputs
  // lose it, other Hyprland bindings are unbound by the module. A plain save
  // of an unchanged shortcut keeps an override set earlier. A name equal to
  // the standard one is stored as no name, so the config stays an overlay.
  function saveInput(override) {
    var bind = root.editBind
    var keep = !override && root.editOriginalOverride
      && Model.canonicalBind(bind) === Model.canonicalBind(root.editOriginal)
    var takeFrom = override ? root.editInputConflicts.map(function(c) { return c.code }) : []
    var name = root.editDraftName.trim()
    if (name === Model.defaultNameFor(root.editCode)) name = ""
    var text = Model.configWithInput(configFile.loaded ? configFile.text() : "", root.editCode, {
      name: name,
      bind: bind,
      override: (override && root.editHyprConflicts.length > 0) || keep,
      hidden: root.editHidden
    }, takeFrom)
    if (text === "") {
      root.errorText = "Can't save while " + root.configPath + " isn't valid JSON."
      return
    }
    saveProc.pendingText = text
    saveProc.command = ["mkdir", "-p", Model.parentDir(root.configPath)]
    saveProc.running = true
    closeEditor()
  }

  IpcHandler {
    target: root.ipcTarget

    function set(input: string): string { return root.setIpc(input) }
    function settings(): void { root.open(); root.openSettings(true) }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  // Carried over from the waybar module this plugin replaces: scrolling the bar
  // icon nudges monitor brightness (VCP 0x10). Scroll events arrive far faster
  // than DDC can answer, so anything that lands mid-write is dropped rather
  // than queued — the alternative is a backlog that keeps stepping after the
  // user's fingers stop.
  function adjustBrightness(delta) {
    if (brightnessStep <= 0 || busy) return
    brightnessProc.command = Model.ddcutilArgs(root.displayNumber,
      ["setvcp", "10", delta > 0 ? "+" : "-", String(root.brightnessStep)], root.busNumber)
    brightnessProc.running = true
  }

  function moveCursor(delta) {
    var count = settingsOpen ? inputs.length : rows.length
    root.cursorIndex = Model.moveIndex(root.cursorIndex, delta, count)
  }

  function activateCursor() {
    if (settingsOpen) {
      if (cursorIndex >= 0 && cursorIndex < inputs.length) openEditor(inputs[cursorIndex])
      return
    }
    if (cursorIndex < 0 || cursorIndex >= rows.length) return
    applyInput(rows[cursorIndex].code)
  }

  // Park the cursor on the active input each time the panel opens, so Enter
  // without any arrow key is a no-op rather than a surprise switch.
  onOpenedChanged: {
    if (!opened) {
      root.recording = false
      root.releaseSubmap()
      root.editCode = ""
      root.settingsOpen = false
      return
    }
    root.cursorActive = false
    root.errorText = ""
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].code === root.currentCode) {
        root.cursorIndex = i
        break
      }
    }
    // The monitor's input list doesn't change between reboots, so pay for
    // discovery once per shell session; every later open just re-reads which
    // input is live. The refresh control forces a full re-probe.
    if (!discoveryTried) refresh()
    else readCurrent()
  }

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.configInputs = Model.parseConfig(text())
      root.configBroken = Model.configIsMalformed(text())
      // A config that fails to parse must not wipe shortcuts the user had
      // working a typo ago; keep the old file until the JSON is valid again.
      if (root.configBroken) return
      root.configSettled = true
      root.syncBindings()
    }
    onLoadFailed: {
      root.configInputs = []
      root.configBroken = false
      root.configSettled = true
      root.syncBindings()
    }
    onFileChanged: reload()
  }

  FileView {
    id: bindingsFile
    path: root.bindingsPath
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.bindingsText = text()
      root.bindingsExist = true
      root.bindingsSettled = true
      root.syncBindings()
    }
    onLoadFailed: {
      root.bindingsExist = false
      root.bindingsSettled = true
      root.syncBindings()
    }
  }

  // Read only to tell whether the generated file is actually loaded, so the
  // popup can say so instead of shortcuts silently doing nothing.
  FileView {
    id: hyprUserBindings
    path: root.hyprDir + "/bindings.lua"
    watchChanges: true
    printErrors: false
    onLoaded: root.hyprUserText = text()
    onLoadFailed: root.hyprUserText = ""
    onFileChanged: reload()
  }

  Process {
    id: bindsProc
    command: ["hyprctl", "binds", "-j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.hyprBindsText = text
    }
    stderr: StdioCollector { waitForEnd: true }
  }

  // Creates the config directory, then writes. Applies the parsed result
  // directly instead of waiting for the file watcher, so the new shortcut is
  // live even if the watcher doesn't report our own write.
  Process {
    id: saveProc
    property string pendingText: ""
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.errorText = "could not create " + Model.parentDir(root.configPath)
        return
      }
      configFile.setText(saveProc.pendingText)
      root.configInputs = Model.parseConfig(saveProc.pendingText)
      root.configBroken = false
      root.configSettled = true
      root.syncBindings()
    }
  }

  Process {
    id: reloadProc
    command: ["hyprctl", "reload"]
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }

  Process {
    id: capsProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var codes = Model.parseCapabilities(text)
        if (codes.length > 0) root.discovered = codes
      }
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: {
      root.discoveryTried = true
      root.readCurrent()
    }
  }

  Process {
    id: getProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var code = Model.parseCurrentCode(text)
        if (code !== "") root.currentCode = code
      }
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.errorText = "ddcutil could not read the current input"
    }
  }

  Process {
    id: setProc
    property string pendingCode: ""
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        // Trust the write rather than paying another 3s read: the monitor has
        // already switched, and re-reading mid-switch often returns the old
        // value anyway.
        root.currentCode = setProc.pendingCode
        root.close()
      } else {
        root.errorText = "ddcutil failed to switch input"
      }
      setProc.pendingCode = ""
    }
  }

  Process {
    id: brightnessProc
    stderr: StdioCollector { waitForEnd: true }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showLabel && !vertical ? "󰍹 " + root.currentLabel : "󰍹"
    slotSize: Style.bar.iconSlot * (root.showLabel && !vertical ? 3 : 1)
    tooltipText: "Monitor input: " + root.currentLabel
    onPressed: function(pressedButton) {
      if (pressedButton === Qt.MiddleButton) root.refresh()
      else root.toggle()
    }
    onWheelMoved: function(delta) { root.adjustBrightness(delta) }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.recording || nameField.activeFocus
      onTextKey: function(t) { if (t === "s") root.openSettings(!root.settingsOpen) }
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dy !== 0 ? dy : dx)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: {
        if (root.editing) root.closeEditor()
        else if (root.settingsOpen) root.openSettings(false)
        else root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          title: root.settingsOpen ? "Settings" : "Monitor input"
          meta: root.settingsOpen ? "NAMES AND SHORTCUTS" : root.statusText
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily

          iconComponent: Text {
            text: "󰍹"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
          }

          // The hero actions live in one Row so PanelHero's trailing Loader
          // sizes and insets them exactly as it would a single control.
          trailingControl: Row {
            spacing: Style.space(2)

            PanelActionButton {
              visible: !root.settingsOpen
              iconText: "󰑐"
              tooltipText: "Re-detect inputs and re-read the current one"
              foreground: root.bar.foreground
              enabled: !root.busy
              onClicked: root.refresh()
            }

            PanelActionButton {
              iconText: root.settingsOpen ? "󰁍" : "󰒓"
              tooltipText: root.settingsOpen ? "Back to the inputs" : "Names and shortcuts (s)"
              foreground: root.bar.foreground
              onClicked: root.openSettings(!root.settingsOpen)
            }
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        PanelSectionHeader {
          visible: !root.settingsOpen
          text: "INPUTS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Column {
          visible: !root.settingsOpen
          width: parent.width
          spacing: Style.space(2)

          Repeater {
            model: root.rows

            InputRow {
              required property var modelData
              required property int index
              width: column.width
              entry: modelData
              rowIndex: index
            }
          }
        }

        Text {
          visible: !root.settingsOpen && root.emptyText !== ""
          width: parent.width
          text: root.emptyText
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        PanelSectionHeader {
          visible: root.settingsOpen
          text: "INPUTS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Column {
          visible: root.settingsOpen
          width: parent.width
          spacing: Style.space(2)

          Repeater {
            model: root.inputs

            ShortcutRow {
              required property var modelData
              required property int index
              width: column.width
              entry: modelData
              rowIndex: index
            }
          }
        }

        Text {
          visible: root.settingsOpen && !root.editing
          width: parent.width
          text: root.inputs.length === 0 ? root.emptyText : "Pick an input to rename it, give it a shortcut or hide it."
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          visible: root.settingsOpen && root.editing
          width: parent.width
          spacing: Style.space(8)

          PanelSeparator {
            foreground: root.bar.foreground
          }

          FieldRow {
            label: "Port"
            Text {
              text: Model.defaultNameFor(root.editCode) + "  ·  " + root.editCode
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.body
            }
          }

          FieldRow {
            label: "Name"
            TextField {
              id: nameField
              width: column.width - Style.space(80)
              text: root.editDraftName
              placeholderText: Model.defaultNameFor(root.editCode)
              foreground: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.body
              onTextEdited: root.editDraftName = text
              onAccepted: keyCatcher.forceActiveFocus()
              Keys.onEscapePressed: function(event) {
                root.editDraftName = root.editName
                keyCatcher.forceActiveFocus()
                event.accepted = true
              }
            }
          }

          FieldRow {
            label: "Shortcut"
            Text {
              text: root.recording ? "press keys…" : (root.editBind === "" ? "none" : root.editBind)
              color: root.recording || root.editBind === "" ? Qt.darker(root.bar.foreground, 1.4) : root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.body
              font.bold: root.editBind !== "" && !root.recording
            }
          }

          // Catches the key press while recording. PanelKeyCatcher is blocked
          // meanwhile, so keys reach this item instead of moving the cursor.
          Item {
            id: recorder
            width: 0
            height: 0
            Keys.onPressed: function(event) {
              if (!root.recording) return
              root.recordKey(event)
              event.accepted = true
            }
          }

          Text {
            width: parent.width
            text: root.recordError !== "" ? root.recordError
              : root.recording ? "Press the whole combination. Your other shortcuts are paused meanwhile."
              : root.editProblem !== "" ? root.editProblem
              : root.editHasConflict ? root.editConflictText + " Save overrides it."
              : ""
            visible: text !== ""
            color: root.recordError !== "" || (root.editProblem !== "" && !root.recording) || root.editHasConflict
              ? (root.bar ? root.bar.urgent : Color.foreground)
              : Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Toggle {
            width: parent.width
            label: "Show in the input list"
            checked: !root.editHidden
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            titleSize: Style.font.body
            onClicked: root.editHidden = !root.editHidden
          }

          Row {
            spacing: Style.space(4)

            Button {
              text: "Clear"
              tooltipText: "No shortcut for this input"
              bordered: true
              enabled: root.editKey !== "" && !root.recording
              opacity: enabled ? 1 : 0.45
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.caption
              onClicked: root.editKey = ""
            }

            Button {
              text: root.recording ? "Stop" : "Record"
              tooltipText: "Click, then press the combination"
              bordered: true
              selected: root.recording
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.caption
              onClicked: root.recording ? root.stopRecording() : root.startRecording()
            }

            // On a clash Save takes the combination over: the other input
            // loses it, another Hyprland binding is switched off.
            Button {
              text: root.editHasConflict ? "Override" : "Save"
              tooltipText: root.editHasConflict ? "Use the shortcut here anyway" : ""
              bordered: true
              enabled: root.editProblem === "" && !root.recording
              opacity: enabled ? 1 : 0.45
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.caption
              onClicked: root.saveInput(root.editHasConflict)
            }

            Button {
              text: "Cancel"
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.caption
              onClicked: root.closeEditor()
            }
          }
        }

        Text {
          visible: root.settingsOpen && root.hasBindings && !root.bindingsRequired
          width: parent.width
          text: "Shortcuts are written to ~/.config/hypr/ddc-input-select.lua. "
            + "Add require(\"hypr.ddc-input-select\") at the end of ~/.config/hypr/bindings.lua "
            + "to turn them on."
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.configBroken
          width: parent.width
          text: "Ignoring " + root.configPath + " — it isn't valid JSON, so these are the monitor's own names."
          color: root.bar ? root.bar.urgent : Color.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.errorText !== ""
          width: parent.width
          text: root.errorText
          color: root.bar ? root.bar.urgent : Color.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  // One selectable input. Visuals come from hasCursor/current via
  // CursorSurface — never from containsMouse — so keyboard and mouse can never
  // paint two highlights at once.
  component InputRow: CursorSurface {
    id: inputRow
    required property var entry
    required property int rowIndex

    readonly property bool isActive: root.currentCode !== "" && entry.code === root.currentCode

    hasCursor: root.cursorActive && root.cursorIndex === rowIndex
    current: isActive
    foreground: root.bar.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: rowInner.implicitHeight + Style.spacing.xl
    // A row the monitor never reported still switches if you insist, but it
    // reads as second-class rather than as an equal peer that quietly no-ops.
    opacity: root.busy ? 0.6 : (entry.unsupported ? 0.45 : 1.0)

    Row {
      id: rowInner
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(6)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(8)

      Text {
        text: inputRow.isActive ? "󰄬" : ""
        color: root.bar.foreground
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.title
        width: Style.space(20)
        horizontalAlignment: Text.AlignHCenter
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        text: inputRow.entry.name
        color: root.bar.foreground
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.body
        font.bold: inputRow.isActive
        elide: Text.ElideRight
        width: parent.width - Style.space(20) - bindLabel.implicitWidth - codeLabel.implicitWidth - Style.space(24)
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: bindLabel
        text: inputRow.entry.bind || ""
        color: Qt.darker(root.bar.foreground, 1.15)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: codeLabel
        text: inputRow.entry.unsupported ? inputRow.entry.code + " ?" : inputRow.entry.code
        color: Qt.darker(root.bar.foreground, 1.4)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) {
        root.cursorActive = true
        root.cursorIndex = inputRow.rowIndex
      }
      onClicked: root.applyInput(inputRow.entry.code)
    }
  }

  // One input on the settings page: its name, whether it's hidden, and its
  // shortcut. Clicking opens the editor for it; the row being edited stays
  // marked.
  component ShortcutRow: CursorSurface {
    id: shortcutRow
    required property var entry
    required property int rowIndex

    hasCursor: root.cursorActive && root.cursorIndex === rowIndex
    current: root.editCode === entry.code
    foreground: root.bar.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: shortcutInner.implicitHeight + Style.spacing.xl

    Row {
      id: shortcutInner
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(6)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(8)

      // Name on top, the port it stands for underneath, so a renamed input
      // stays recognisable.
      Column {
        width: parent.width - shortcutLabel.implicitWidth - Style.space(8)
        anchors.verticalCenter: parent.verticalCenter

        Text {
          width: parent.width
          text: shortcutRow.entry.name + (shortcutRow.entry.hidden ? "  (hidden)" : "")
          color: shortcutRow.entry.hidden ? Qt.darker(root.bar.foreground, 1.4) : root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          font.bold: shortcutRow.current
          elide: Text.ElideRight
        }

        Text {
          width: parent.width
          text: Model.defaultNameFor(shortcutRow.entry.code) + "  ·  " + shortcutRow.entry.code
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        id: shortcutLabel
        text: shortcutRow.entry.bind ? shortcutRow.entry.bind : "none"
        color: shortcutRow.entry.bind ? root.bar.foreground : Qt.darker(root.bar.foreground, 1.6)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) {
        root.cursorActive = true
        root.cursorIndex = shortcutRow.rowIndex
      }
      onClicked: root.openEditor(shortcutRow.entry)
    }
  }

  // A labelled line in the input editor: fixed-width label, then the value.
  component FieldRow: Row {
    property string label: ""
    default property alias content: valueSlot.data
    width: column.width
    height: Math.max(labelText.implicitHeight, valueSlot.childrenRect.height)
    spacing: Style.space(8)

    Text {
      id: labelText
      width: Style.space(72)
      anchors.verticalCenter: parent.verticalCenter
      text: parent.label
      color: Qt.darker(root.bar.foreground, 1.4)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption
    }

    Item {
      id: valueSlot
      width: parent.width - labelText.width - parent.spacing
      height: childrenRect.height
    }
  }
}
