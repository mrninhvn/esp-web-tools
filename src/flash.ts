import { Transport, ESPLoader, IEspLoaderTerminal } from "/home/ninh/apps/rogo.com.vn/flasher/esp-web-tools/src/esptool-js/lib";
// import { ROM } from "./esptool-js/lib/targets/rom";
// import { ESP32C3ROM } from "./esptool-js/lib/targets/esp32c3";
import {
  Build,
  FlashError,
  FlashState,
  Manifest,
  FlashStateType,
} from "./const";
import { sleep } from "./util/sleep";

const resetTransport = async (transport: Transport) => {
  await transport.device.setSignals({
    dataTerminalReady: false,
    requestToSend: true,
  });
  await transport.device.setSignals({
    dataTerminalReady: false,
    requestToSend: false,
  });
}; 
// export class ESPLoaderNew extends ESPLoader {
//   chipNew: ESP32C3ROM = new ESP32C3ROM();
//   constructor(transport: Transport, baudrate: any, terminal: IEspLoaderTerminal | undefined){
//     super(transport, baudrate,terminal)
//     this.chip = this.chipNew
//   }

//   public override async detect_chip(mode = "default_reset") {
//     await this.connect(mode, 7, true);
//     this.info("Detecting chip type... ", false);
//     if (this.chip != null) {
//         this.info(this.chip.CHIP_NAME);
//     }
//     else {
//         this.info("unknown!");
//     }
//   }

//   public override async main_fn(mode?: string | undefined): Promise<any> {
//     await this.detect_chip(mode);
//     this.info("Features: " + (await this.chip.get_chip_features(this)));
//     this.info("Crystal is " + (await this.chip.get_crystal_freq(this)) + "MHz");
//     if (typeof this.chip._post_connect != "undefined") {
//       await this.chip._post_connect(this);
//     }
//     // await this.run_stub();
//     // if (this.rom_baudrate !== this.baudrate) {
//       // await this.change_baud();
//     // }
//     return this.chip;
//   }
// }

export const flash = async (
  onEvent: (state: FlashState) => void,
  port: SerialPort,
  manifestPath: string,
  manifest: Manifest,
  eraseFirst: boolean
) => {
  let build: Build | undefined;
  let chipFamily: Build["chipFamily"];

  const fireStateEvent = (stateUpdate: FlashState) =>
    onEvent({
      ...stateUpdate,
      manifest,
      build,
      chipFamily,
    });

  const transport = new Transport(port);
  const esploader = new ESPLoader(transport, 115200, undefined);
  // const esploader = new ESPLoaderNew(transport, 115200, undefined);

  // For debugging
  (window as any).esploader = esploader;

  fireStateEvent({
    state: FlashStateType.INITIALIZING,
    message: "Initializing...",
    details: { done: false },
  });

  try {
    await esploader.main_fn("default_reset", manifest.new_install_speed);
    // await esploader.flash_id();
  } catch (err: any) {
    console.error(err);
    fireStateEvent({
      state: FlashStateType.ERROR,
      message:
        "Failed to initialize. Try resetting your device or holding the BOOT button while clicking INSTALL.",
      details: { error: FlashError.FAILED_INITIALIZING, details: err },
    });
    await resetTransport(transport);
    await transport.disconnect();
    return;
  }

  // console.log("chipName", esploader.chipNew)
  // chipFamily = esploader.chipNew.CHIP_NAME as any;
  chipFamily = esploader.chip.CHIP_NAME as any;
  console.log("Stub:", esploader.IS_STUB);
  let compressDownload : boolean = false;
  if (esploader.IS_STUB == true){
    compressDownload = true;
  }
  // if (esploader.IS_STUB == false){
  //   compressDownload = true;
  // }
  console.log("Compress Download:", compressDownload);

  if (!esploader.chip.ROM_TEXT) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: `Chip ${chipFamily} is not supported`,
      details: {
        error: FlashError.NOT_SUPPORTED,
        details: `Chip ${chipFamily} is not supported`,
      },
    });
    await resetTransport(transport);
    await transport.disconnect();
    return;
  }

  fireStateEvent({
    state: FlashStateType.INITIALIZING,
    message: `Initialized. Found ${chipFamily}`,
    details: { done: true },
  });

  build = manifest.builds.find((b) => b.chipFamily === chipFamily);

  if (!build) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: `Your ${chipFamily} board is not supported.`,
      details: { error: FlashError.NOT_SUPPORTED, details: chipFamily },
    });
    await resetTransport(transport);
    await transport.disconnect();
    return;
  }

  fireStateEvent({
    state: FlashStateType.PREPARING,
    message: "Preparing installation...",
    details: { done: false },
  });

  const manifestURL = new URL(manifestPath, location.toString()).toString();
  const filePromises = build.parts.map(async (part) => {
    const url = new URL(part.path, manifestURL).toString();
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `Downlading firmware ${part.path} failed: ${resp.status}`
      );
    }

    const reader = new FileReader();
    const blob = await resp.blob();

    return new Promise<string>((resolve) => {
      reader.addEventListener("load", () => resolve(reader.result as string));
      reader.readAsBinaryString(blob);
    });
  });

  const fileArray: Array<{ data: string; address: number }> = [];
  let totalSize = 0;

  for (let part = 0; part < filePromises.length; part++) {
    try {
      const data = await filePromises[part];
      fileArray.push({ data, address: build.parts[part].offset });
      totalSize += data.length;
    } catch (err: any) {
      fireStateEvent({
        state: FlashStateType.ERROR,
        message: err.message,
        details: {
          error: FlashError.FAILED_FIRMWARE_DOWNLOAD,
          details: err.message,
        },
      });
      await resetTransport(transport);
      await transport.disconnect();
      return;
    }
  }

  fireStateEvent({
    state: FlashStateType.PREPARING,
    message: "Installation prepared",
    details: { done: true },
  });

  if (eraseFirst) {
    fireStateEvent({
      state: FlashStateType.ERASING,
      message: "Erasing device...",
      details: { done: false },
    });
    await esploader.erase_flash();
    fireStateEvent({
      state: FlashStateType.ERASING,
      message: "Device erased",
      details: { done: true },
    });
  }

  fireStateEvent({
    state: FlashStateType.WRITING,
    message: `Writing progress: 0%`,
    details: {
      bytesTotal: totalSize,
      bytesWritten: 0,
      percentage: 0,
    },
  });

  let totalWritten = 0;

  try {
    await esploader.write_flash(
      fileArray,
      manifest.flash_size, // "4MB"
      manifest.flash_mode, // "dio",
      manifest.flash_freq, // "80m",
      false,
      compressDownload,
      manifest.encrypt_bin,
      // report progress
      (fileIndex: number, written: number, total: number) => {
        const uncompressedWritten =
          (written / total) * fileArray[fileIndex].data.length;

        const newPct = Math.floor(
          ((totalWritten + uncompressedWritten) / totalSize) * 100
        );

        // we're done with this file
        if (written === total) {
          totalWritten += uncompressedWritten;
          return;
        }

        fireStateEvent({
          state: FlashStateType.WRITING,
          message: `Writing progress: ${newPct}%`,
          details: {
            bytesTotal: totalSize,
            bytesWritten: totalWritten + written,
            percentage: newPct,
          },
        });
      }
    );
  } catch (err: any) {
    fireStateEvent({
      state: FlashStateType.ERROR,
      message: err.message,
      details: { error: FlashError.WRITE_FAILED, details: err },
    });
    await resetTransport(transport);
    await transport.disconnect();
    return;
  }

  fireStateEvent({
    state: FlashStateType.WRITING,
    message: "Writing complete",
    details: {
      bytesTotal: totalSize,
      bytesWritten: totalWritten,
      percentage: 100,
    },
  });

  await sleep(100);
  console.log("HARD RESET");
  await resetTransport(transport);
  console.log("DISCONNECT");
  await transport.disconnect();

  fireStateEvent({
    state: FlashStateType.FINISHED,
    message: "All done!",
  });
};
