PREFIX      ?= $(HOME)/.local
BINDIR      ?= $(PREFIX)/bin
CONFIG_DIR  ?= $(if $(XDG_CONFIG_HOME),$(XDG_CONFIG_HOME),$(HOME)/.config)/ddc-input-select

SCRIPT      := bin/ddc-input-select

PLUGIN_ID   := io.github.mattflower.ddc-input-select
PLUGIN_DIR  ?= $(if $(XDG_CONFIG_HOME),$(XDG_CONFIG_HOME),$(HOME)/.config)/omarchy/plugins/$(PLUGIN_ID)
PLUGIN_SRC  := manifest.json Panel.qml Model.js
OMARCHY_SHELL ?= $(HOME)/.local/share/omarchy/shell

.PHONY: install uninstall check test test-model help install-plugin uninstall-plugin check-plugin

help:
	@echo "Targets:"
	@echo "  install           install $(SCRIPT) to $(BINDIR)"
	@echo "  uninstall         remove the binary (config is left untouched)"
	@echo "  check             run shellcheck on $(SCRIPT) if available"
	@echo "  test              run every test (currently test-model)"
	@echo "  test-model        unit-test Model.js under node"
	@echo "  install-plugin    copy the Omarchy Quattro bar plugin into $(PLUGIN_DIR)"
	@echo "  uninstall-plugin  remove the plugin directory"
	@echo "  check-plugin      validate the manifest and lint the QML"

# No config is seeded: the monitor is asked what inputs it has, and the config
# file exists only to rename them. `--detect` writes a starting point.
install:
	@install -d $(BINDIR)
	@install -m 0755 $(SCRIPT) $(BINDIR)/ddc-input-select
	@echo "Installed: $(BINDIR)/ddc-input-select"
	@echo
	@echo "Inputs are detected from the monitor. To rename them, seed a config:"
	@echo "  mkdir -p $(CONFIG_DIR)"
	@echo "  ddc-input-select --detect > $(CONFIG_DIR)/inputs.json"
	@echo
	@echo "Waybar snippet (add to ~/.config/waybar/config.jsonc):"
	@echo
	@printf '  "custom/monitor-input": {\n'
	@printf '    "format": "\xf3\xb0\x8d\xb9",\n'
	@printf '    "tooltip": "Switch monitor input",\n'
	@printf '    "on-click": "ddc-input-select"\n'
	@printf '  }\n'
	@echo
	@echo 'Then add "custom/monitor-input" to modules-right.'
	@echo
	@echo 'For consistent spacing with other icons, also add #custom-monitor-input'
	@echo 'to ~/.config/waybar/style.css alongside the existing margin rule, e.g.:'
	@echo
	@echo '  #cpu,'
	@echo '  #battery,'
	@echo '  #pulseaudio,'
	@echo '  #custom-monitor-input {'
	@echo '    min-width: 12px;'
	@echo '    margin-right: 16px;'
	@echo '  }'
	@echo
	@echo 'Reload waybar: pkill -SIGUSR2 waybar'

uninstall:
	@rm -f $(BINDIR)/ddc-input-select
	@echo "removed $(BINDIR)/ddc-input-select (config at $(CONFIG_DIR) left in place)"

test: test-model

test-model:
	@if command -v node >/dev/null; then \
		node test/model_test.js; \
	else \
		echo "node not installed; skipping Model.js tests"; \
	fi

check:
	@if command -v shellcheck >/dev/null; then \
		shellcheck $(SCRIPT); \
	else \
		echo "shellcheck not installed; skipping"; \
	fi

# --- Omarchy Quattro bar plugin -------------------------------------------
#
# The plugin talks to ddcutil itself, so these targets are independent of
# `make install` — it needs neither the script nor a config file. Saving a file
# under ~/.config/omarchy/plugins/ makes the shell hot-reload it, so re-running
# install-plugin is enough to pick up an edit — no restart.

install-plugin: check-plugin
	@install -d $(PLUGIN_DIR)
	@install -m 0644 $(PLUGIN_SRC) $(PLUGIN_DIR)/
	@omarchy-shell -q shell rescanPlugins
	@echo "Installed plugin to $(PLUGIN_DIR)"
	@echo
	@echo "Enable it with:"
	@echo "  omarchy plugin enable $(PLUGIN_ID) right"

uninstall-plugin:
	@omarchy plugin disable $(PLUGIN_ID) 2>/dev/null || true
	@rm -rf $(PLUGIN_DIR)
	@omarchy-shell -q shell rescanPlugins
	@echo "removed $(PLUGIN_DIR)"

check-plugin:
	@if command -v omarchy >/dev/null; then \
		omarchy plugin validate . || exit 1; \
		echo "manifest ok"; \
	else \
		echo "omarchy not installed; skipping manifest validation"; \
	fi
	@if command -v qmllint >/dev/null && [ -d $(OMARCHY_SHELL) ]; then \
		qmllint -I $(OMARCHY_SHELL) Panel.qml || exit 1; \
		echo "qmllint ok"; \
	else \
		echo "qmllint or $(OMARCHY_SHELL) missing; skipping QML lint"; \
	fi
