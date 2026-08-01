/* eslint-disable class-methods-use-this */
import {
  IDeviceConnection,
  IDevice,
  ConnectionTypeMap,
  PoolData,
  DeviceState,
  DeviceConnectionError,
  DeviceConnectionErrorType,
} from '@cypherock/sdk-interfaces';
import * as uuid from 'uuid';
import * as webbluetooth from 'webbluetooth';
import { type BluetoothRemoteGATTCharacteristic } from 'webbluetooth/dist/characteristic';
import { type BluetoothDevice } from 'webbluetooth/dist/device';
import { logger } from './logger';

const bluetooth = new webbluetooth.Bluetooth({ scanTime: 20, allowAllDevices: true });

/* This library maintains a global state of all the available X1 BLE devices,
 * the ID of the device is then used in `IDevice.path` because extending IDevice
 * itself is not viable to hold `BluetoothDevice` without some major rework.
 *
 * If it's already not obvious enough, It is not safe to call `DeviceConnection.list`
 * asynchronously or in parallel as it will lead to race conditions.
 */
let availableDevices: BluetoothDevice[] = [];

// CustomEvent polyfill
if (globalThis.CustomEvent === undefined) {
    class CustomEvent<T = unknown> extends Event {
        readonly detail: T;

        constructor(type: string, options?: CustomEventInit<T>) {
            super(type, options);
            this.detail = options?.detail as T;
        }
    }

    (globalThis as any).CustomEvent = CustomEvent;
}

export default class DeviceConnection implements IDeviceConnection {
  protected sequenceNumber: number;

  private connected: boolean;

  private deviceState: DeviceState;

  private readonly pool: PoolData[];

  private readonly device: BluetoothDevice;

  private readonly charRx: BluetoothRemoteGATTCharacteristic;

  private readonly charTx: BluetoothRemoteGATTCharacteristic;

  private readonly charDeviceStatus: BluetoothRemoteGATTCharacteristic;

  constructor(device: BluetoothDevice, charRx: BluetoothRemoteGATTCharacteristic, charTx: BluetoothRemoteGATTCharacteristic, charDeviceStatus: BluetoothRemoteGATTCharacteristic) {
    this.pool = [];
    this.device = device;
    this.charRx = charRx;
    this.charTx = charTx;
    this.charDeviceStatus = charDeviceStatus;
    this.sequenceNumber = 0;
    this.connected = true;
    this.deviceState = DeviceState.INITIAL;

    charDeviceStatus.addEventListener("characteristicvaluechanged", async (e) => {
      e.preventDefault();
      if (charDeviceStatus.value) {
        this.updateDeviceStatus(charDeviceStatus.value.getUint8(0));
      } else {
        logger.warn("'characteristicvaluechanged' triggered but no data received!");
      }
    });
    charDeviceStatus.startNotifications();

    charTx.addEventListener("characteristicvaluechanged", async (e) => {
      e.preventDefault();
      if (charTx.value) {
        this.pool.push({
          id: uuid.v4(),
          data: new Uint8Array(charTx.value.buffer)
        })
      } else {
        logger.warn("'characteristicvaluechanged' triggered but no data received!");
      }
    });
    charTx.startNotifications();
  }

  private updateDeviceStatus(deviceStatus: number) {
    const is_connected = (deviceStatus & 0x1) == 1;
    const is_in_bootloader_mode = ((deviceStatus >> 1) & 0x1) == 1;

    this.deviceState = is_in_bootloader_mode ? DeviceState.BOOTLOADER : DeviceState.MAIN;
  }

  private async fetchDeviceStatus() {
    const status = await this.charDeviceStatus.readValue();
    this.updateDeviceStatus(status.getUint8(0));
  }

  public async getConnectionType(): Promise<string> {
    return ConnectionTypeMap.BLE;
  }

  public static async connect(idevice: IDevice) : Promise<DeviceConnection> {
    const device = availableDevices.find(d => d.id === idevice.path);
    if (!device) {
      throw new DeviceConnectionError(DeviceConnectionErrorType.NOT_CONNECTED);
    }

    await device.gatt.connect();

    const service = await device.gatt.getPrimaryService("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    const charRx = await service.getCharacteristic("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    const charTx = await service.getCharacteristic("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
    const charDeviceStatus = await service.getCharacteristic("6E400004-B5A3-F393-E0A9-E50E24DCCA9E");

    return new DeviceConnection(device, charRx, charTx, charDeviceStatus);
  }

  public static async list() {
    availableDevices = (await bluetooth.getDevices()).filter((d) => d.name.startsWith("X1 BLE"));
    const idevices: IDevice[] = availableDevices.map(d => <IDevice>{
      type: ConnectionTypeMap.BLE,
      deviceState: DeviceState.MAIN,
      path: d.id,
      serial: "",
      productId: 0,
      vendorId: 0
    });

    return idevices;
  }

  public static async create() {
    const devices = await DeviceConnection.list();

    if (devices.length <= 0) {
      throw new DeviceConnectionError(DeviceConnectionErrorType.NOT_CONNECTED);
    }

    return DeviceConnection.connect(devices[0]);
  }

  public async isConnected(): Promise<boolean> {
    return this.connected;
  }

  public async beforeOperation(): Promise<void> {
    return;
  }

  public async afterOperation(): Promise<void> {
    return;
  }

  public async isInitialized() {
    return true;
  }

  public async getSequenceNumber(): Promise<number> {
    return this.sequenceNumber;
  }

  public async getNewSequenceNumber(): Promise<number> {
    this.sequenceNumber += 1;
    return this.sequenceNumber;
  }

  public async getDeviceState(): Promise<DeviceState> {
    await this.fetchDeviceStatus();
    return this.deviceState;
  }

  public async send(data: Uint8Array): Promise<void> {
    /* 'MAIN' state uses HID, which communicates in 64-byte packets as
       compared to 'BOOTLOADER' state which is basically a serial port */
    if (this.deviceState === DeviceState.MAIN) {
      const dataToWrite = [
        ...data,
        ...new Array(64 - data.length).fill(0x00),
      ];
      await this.charRx.writeValueWithoutResponse(Uint8Array.from(dataToWrite));
    } else if (this.deviceState === DeviceState.BOOTLOADER) {
      await this.charRx.writeValueWithoutResponse(data);
    } else {
      logger.warn(`Trying to write ${data.length} bytes in 'INITIAL' state.`);
    }
  }

  public async receive(): Promise<Uint8Array | undefined> {
    return this.pool.shift()?.data;
  }

  public async peek(): Promise<PoolData[]> {
    return [...this.pool];
  }

  public async destroy(): Promise<void> {
    this.charDeviceStatus.stopNotifications();
    this.charTx.stopNotifications();
    this.device.gatt.disconnect();
    this.connected = false;
  }
}
