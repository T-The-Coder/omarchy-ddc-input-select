PREFIX      ?= $(HOME)/.local
BINDIR      ?= $(PREFIX)/bin
SHAREDIR    ?= $(PREFIX)/share/ddc-input-select
CONFIG_DIR  ?= $(if $(XDG_CONFIG_HOME),$(XDG_CONFIG_HOME),$(HOME)/.config)/ddc-input-select

SCRIPT      := bin/ddc-input-select
EXAMPLE     := config/inputs.example.json

.PHONY: install uninstall check help

help:
	@echo "Targets:"
	@echo "  install    install $(SCRIPT) to $(BINDIR) and seed $(CONFIG_DIR)/inputs.json"
	@echo "  uninstall  remove the binary (config is left untouched)"
	@echo "  check      run shellcheck on $(SCRIPT) if available"

install:
	@install -d $(BINDIR) $(SHAREDIR) $(CONFIG_DIR)
	@install -m 0755 $(SCRIPT) $(BINDIR)/ddc-input-select
	@install -m 0644 $(EXAMPLE) $(SHAREDIR)/inputs.example.json
	@# Patch the script to point at the installed example so first-run seeding works.
	@sed -i 's|^EXAMPLE_CONFIG=.*|EXAMPLE_CONFIG="$${DDC_INPUT_SELECT_EXAMPLE:-$(SHAREDIR)/inputs.example.json}"|' $(BINDIR)/ddc-input-select
	@if [ ! -f $(CONFIG_DIR)/inputs.json ]; then \
		install -m 0644 $(EXAMPLE) $(CONFIG_DIR)/inputs.json; \
		echo "seeded $(CONFIG_DIR)/inputs.json"; \
	else \
		echo "$(CONFIG_DIR)/inputs.json already exists; left untouched"; \
	fi
	@echo
	@echo "Installed: $(BINDIR)/ddc-input-select"
	@echo "Config:    $(CONFIG_DIR)/inputs.json"
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
	@rm -f $(SHAREDIR)/inputs.example.json
	@rmdir $(SHAREDIR) 2>/dev/null || true
	@echo "removed $(BINDIR)/ddc-input-select (config at $(CONFIG_DIR) left in place)"

check:
	@if command -v shellcheck >/dev/null; then \
		shellcheck $(SCRIPT); \
	else \
		echo "shellcheck not installed; skipping"; \
	fi
