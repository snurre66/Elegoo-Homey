'use strict';

const Homey = require('homey');
const Discovery = require('../../lib/Discovery');

class ElegooCCDriver extends Homey.Driver {
  async onInit() {
    this.log('Elegoo CC Driver initialized');
  }

  /**
   * Correlate a discovered printer with existing Homey devices.
   * Returns a device descriptor with status metadata.
   */
  _correlateWithExisting(printer, existingDevices) {
    let name = printer.name || 'Elegoo Printer';
    const mid = printer.mainboardID;

    const existingDevice = existingDevices.find((d) => {
      const settings = d.getSettings();
      return (mid && (settings.mainboard_id === mid || d.getData().id === mid)) || d.getData().id === printer.address;
    });

    let dataId = mid || printer.address;
    let isDuplicate = false;
    let status = 'ready';
    let repairRequired = false;

    if (existingDevice) {
      this.log(`Correlated printer with existing device: ${existingDevice.getName()}`);
      dataId = existingDevice.getData().id;
      isDuplicate = true;
      name = existingDevice.getName();

      const oldAddress = existingDevice.getSetting('address');
      if (oldAddress !== printer.address) {
        status = 'ip_changed';
        repairRequired = true;
      } else {
        status = 'already_added';
      }
    }

    return {
      name,
      data: { id: dataId },
      isDuplicate,
      status,
      repairRequired,
      settings: {
        address: printer.address,
        model: printer.model,
        mainboard_id: mid,
      },
    };
  }

  /**
   * Homey Pairing Flow
   */
  onPair(session) {
    session.setHandler('discover', async () => {
      this.log('Searching for Elegoo printers...');
      try {
        const discoveredPrinters = await Discovery.discover();
        this.log(`Found ${discoveredPrinters.length} printers`);

        const existingDevices = this.getDevices();
        const usedIds = new Set();
        const pairedPrinters = [];

        for (const printer of discoveredPrinters) {
          const device = this._correlateWithExisting(printer, existingDevices);

          // Strict deduplication for the pairing list
          if (usedIds.has(device.data.id)) {
            this.log(`Skipping duplicate dataId in discovery list: ${device.data.id}`);
            continue;
          }
          usedIds.add(device.data.id);

          pairedPrinters.push(device);
          this.log('Discovered printer:', device.name, '@', device.data.id, '[', device.status, ']');
        }

        return pairedPrinters;
      } catch (err) {
        this.error('Discovery failed:', err.message);
        throw err;
      }
    });

    session.setHandler('validate_manual', async (data) => {
      this.log('Probing printer at', data.ip, 'port', data.port);
      try {
        const printer = await Discovery.probe(data.ip, data.port);
        if (printer) {
          const existingDevices = this.getDevices();
          const device = this._correlateWithExisting(printer, existingDevices);
          this.log('Found printer through manual probe:', device.name, '@', device.data.id, '[', device.status, ']');
          return device;
        }
        this.log('No printer found at', data.ip);
        return null;
      } catch (err) {
        this.error('Probe failed:', err.message);
        throw err;
      }
    });

    session.setHandler('repair_existing', async (device) => {
      this.log('User requested repair for existing device:', device.name);
      const existingDevices = this.getDevices();
      const existingDevice = existingDevices.find((d) => d.getData().id === device.data.id);

      if (existingDevice) {
        this.log(`Updating settings for ${existingDevice.getName()}...`);
        await existingDevice.setSettings({
          address: device.settings.address,
          mainboard_id: device.settings.mainboard_id || existingDevice.getSetting('mainboard_id'),
        });
        return true;
      }
      throw new Error('Existing device not found for repair');
    });

    session.setHandler('add_device', async (device) => {
      this.log('Adding device:', device.name);
      return true;
    });
  }

  /**
   * Homey Repair Flow
   */
  onRepair(session, device) {
    this.log(`Repairing device: ${device.getName()}`);

    session.setHandler('show_view', async (viewId) => {
      this.log(`Repair view: ${viewId}`);
    });

    session.setHandler('discover', async () => {
      try {
        const discoveredPrinters = await Discovery.discover();
        const settings = device.getSettings();
        const mid = settings.mainboard_id;

        return discoveredPrinters.map((printer) => {
          let name = printer.name || 'Elegoo Printer';
          const isMatch = (mid && printer.mainboardID === mid) || printer.address === settings.address;
          if (isMatch) name += ' (Found)';

          return {
            name,
            data: { id: printer.mainboardID || printer.address },
            settings: {
              address: printer.address,
              model: printer.model,
              mainboard_id: printer.mainboardID,
            },
          };
        });
      } catch (err) {
        this.error('Repair discovery failed:', err.message);
        throw err;
      }
    });

    session.setHandler('repair_device', async (data) => {
      this.log('Repairing with data:', data);
      await device.setSettings({
        address: data.settings.address,
        mainboard_id: data.settings.mainboard_id || device.getSetting('mainboard_id'),
      });
      return true;
    });

    session.setHandler('disconnect', () => {
      this.log('Repair session disconnected');
    });
  }
}

module.exports = ElegooCCDriver;
