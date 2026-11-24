import { parentPort, workerData } from "node:worker_threads";
import { captureHandoffBoundaries } from "./transcript-boundary.ts";

parentPort.postMessage(captureHandoffBoundaries(workerData.path, workerData.offsets));
