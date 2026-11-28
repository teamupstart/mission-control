import { parentPort, workerData } from "node:worker_threads";
import { publishDatabaseBackup } from "./publication.ts";

publishDatabaseBackup(workerData.temporary, workerData.destination);
parentPort.postMessage("published");
