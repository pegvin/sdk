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

  private readonly pool: PoolData[];

  private readonly device: BluetoothDevice;

  private readonly charRx: BluetoothRemoteGATTCharacteristic;

  private readonly charTx: BluetoothRemoteGATTCharacteristic;

  constructor(device: BluetoothDevice, charRx: BluetoothRemoteGATTCharacteristic, charTx: BluetoothRemoteGATTCharacteristic) {
    this.pool = [];
    this.device = device;
    this.charRx = charRx;
    this.charTx = charTx;
    this.sequenceNumber = 0;
    this.connected = true;

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

    return new DeviceConnection(device, charRx, charTx);
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
    return DeviceState.MAIN;
  }

  public async send(data: Uint8Array): Promise<void> {
    const dataToWrite = [
      ...data,
      ...new Array(64 - data.length).fill(0x00),
    ];
    await this.charRx.writeValueWithoutResponse(Uint8Array.from(dataToWrite));
  }

  public async receive(): Promise<Uint8Array | undefined> {
    return this.pool.shift()?.data;
  }

  public async peek(): Promise<PoolData[]> {
    return [...this.pool];
  }

  public async destroy(): Promise<void> {
    this.charTx.stopNotifications();
    this.device.gatt.disconnect();
    this.connected = false;
  }
}
