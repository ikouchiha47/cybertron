FQBN     := Seeeduino:nrf52:xiaonRF52840Sense
SKETCH   := emg_test
BUILDDIR := build
UF2CONV  := python3 $(HOME)/Library/Arduino15/packages/Seeeduino/hardware/nrf52/1.1.12/tools/uf2conv/uf2conv.py
UF2FAM   := 0xADA52840

.PHONY: build clean flash

build:
	arduino-cli compile \
	  --fqbn $(FQBN) \
	  --output-dir $(BUILDDIR) \
	  $(SKETCH)
	$(UF2CONV) -c -f $(UF2FAM) -o emg_test.uf2 $(BUILDDIR)/$(SKETCH).ino.hex
	@echo "==> emg_test.uf2 ready"

clean:
	rm -rf $(BUILDDIR)

# Double-tap XIAO reset button to enter bootloader, then `make flash`.
flash: build
	@if [ -d /Volumes/XIAO-SENSE ]; then \
	  cp emg_test.uf2 /Volumes/XIAO-SENSE/ && echo "==> flashed"; \
	else \
	  echo "XIAO-SENSE not mounted — double-tap reset to enter bootloader"; \
	  exit 1; \
	fi
