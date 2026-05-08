FQBN     := Seeeduino:nrf52:xiaonRF52840Sense
SKETCH   := wristturn
BUILDDIR := build
UF2CONV  := python3 $(HOME)/Library/Arduino15/packages/Seeeduino/hardware/nrf52/1.1.12/tools/uf2conv/uf2conv.py
UF2FAM   := 0xADA52840

.PHONY: build clean flash

build:
	arduino-cli compile --fqbn $(FQBN) --output-dir $(BUILDDIR) $(SKETCH)
	$(UF2CONV) -c -f $(UF2FAM) -o firmware.uf2 $(BUILDDIR)/$(SKETCH).ino.hex
	cp $(BUILDDIR)/$(SKETCH).ino.hex $(SKETCH)/firmware.hex
	@echo "==> firmware.uf2 ($(shell ls -lh firmware.uf2 2>/dev/null | awk '{print $$5}'))"
	@echo "==> wristturn/firmware.hex refreshed"

clean:
	rm -rf $(BUILDDIR)

# Drag-and-drop flash: double-tap the XIAO reset button to enter bootloader
# (mounts as XIAO-SENSE volume), then `make flash`.
flash: build
	@if [ -d /Volumes/XIAO-SENSE ]; then \
	  cp firmware.uf2 /Volumes/XIAO-SENSE/ && echo "==> flashed"; \
	else \
	  echo "XIAO-SENSE not mounted — double-tap reset to enter bootloader"; \
	  exit 1; \
	fi
