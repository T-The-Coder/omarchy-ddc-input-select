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

  readonly property int displayNumber: setting("displayNumber", 0)
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
    capsProc.command = Model.ddcutilArgs(root.displayNumber, ["capabilities", "--terse"])
    capsProc.running = true
  }

  function readCurrent() {
    if (getProc.running || setProc.running) return
    getProc.command = Model.ddcutilArgs(root.displayNumber, ["getvcp", "60", "--terse"])
    getProc.running = true
  }

  function applyInput(code) {
    if (busy) return
    var normalized = Model.normalizeCode(code)
    if (normalized === "") return
    root.errorText = ""
    setProc.pendingCode = normalized
    setProc.command = Model.ddcutilArgs(root.displayNumber, ["setvcp", "60", normalized])
    setProc.running = true
  }

  // Carried over from the waybar module this plugin replaces: scrolling the bar
  // icon nudges monitor brightness (VCP 0x10). Scroll events arrive far faster
  // than DDC can answer, so anything that lands mid-write is dropped rather
  // than queued — the alternative is a backlog that keeps stepping after the
  // user's fingers stop.
  function adjustBrightness(delta) {
    if (brightnessStep <= 0 || busy) return
    brightnessProc.command = Model.ddcutilArgs(root.displayNumber,
      ["setvcp", "10", delta > 0 ? "+" : "-", String(root.brightnessStep)])
    brightnessProc.running = true
  }

  // The edit pencil lives in the hero, but it still occupies the last slot in
  // the cursor space: stepping past the final input lands on it, so keyboard
  // users reach it without a separate key. PanelActionButton.hasCursor makes it
  // paint the same highlight a row would.
  readonly property int editIndex: rows.length
  readonly property bool hasConfig: configInputs.length > 0

  function moveCursor(delta) {
    root.cursorIndex = Model.moveIndex(root.cursorIndex, delta, rows.length + 1)
  }

  function activateCursor() {
    if (cursorIndex === editIndex) { editConfig(); return }
    if (cursorIndex < 0 || cursorIndex >= rows.length) return
    applyInput(rows[cursorIndex].code)
  }

  // Open the config in the user's chosen editor. With no config yet, one is
  // written first from what the monitor reported — sending someone to an empty
  // file when we already know every code they need would just be homework.
  function editConfig() {
    if (hasConfig || rows.length === 0) { launchEditor(); return }
    mkdirProc.command = ["mkdir", "-p", Model.parentDir(root.configPath)]
    mkdirProc.running = true
  }

  function launchEditor() {
    Quickshell.execDetached(["omarchy-launch-config-editor", root.configPath])
    root.close()
  }

  // Park the cursor on the active input each time the panel opens, so Enter
  // without any arrow key is a no-op rather than a surprise switch.
  onOpenedChanged: {
    if (!opened) return
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
    }
    onLoadFailed: {
      root.configInputs = []
      root.configBroken = false
    }
    onFileChanged: reload()
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

  // The config directory is created before the seed write because FileView
  // writes a file, not a path — a missing parent is a silent failure.
  Process {
    id: mkdirProc
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) configFile.setText(Model.seedConfigJson(root.inputs))
      else root.errorText = "could not create " + Model.parentDir(root.configPath)
      root.launchEditor()
    }
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
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dy !== 0 ? dy : dx)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          title: "Monitor input"
          meta: root.statusText
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily

          iconComponent: Text {
            text: "󰍹"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
          }

          // Both hero actions live in one Row so PanelHero's trailing Loader
          // sizes and insets the pair exactly as it would a single control.
          trailingControl: Row {
            spacing: Style.space(2)

            PanelActionButton {
              iconText: "󰏫"
              tooltipText: root.hasConfig
                ? "Edit names — " + root.configPath
                : "Name these inputs — creates " + root.configPath
              foreground: root.bar.foreground
              hasCursor: root.cursorActive && root.cursorIndex === root.editIndex
              onClicked: root.editConfig()
              onHovered: function(isHovered) {
                if (isHovered) {
                  root.cursorActive = true
                  root.cursorIndex = root.editIndex
                }
              }
            }

            PanelActionButton {
              iconText: "󰑐"
              tooltipText: "Re-detect inputs and re-read the current one"
              foreground: root.bar.foreground
              enabled: !root.busy
              onClicked: root.refresh()
            }
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        PanelSectionHeader {
          text: "INPUTS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Column {
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
          visible: root.emptyText !== ""
          width: parent.width
          text: root.emptyText
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
        width: parent.width - Style.space(20) - codeLabel.implicitWidth - Style.space(16)
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
}
