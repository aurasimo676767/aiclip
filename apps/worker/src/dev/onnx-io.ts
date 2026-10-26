import * as ort from "onnxruntime-node";

/** Ingressi e uscite di un modello ONNX (sviluppo). Uso: tsx src/dev/onnx-io.ts <file.onnx> */
const s = await ort.InferenceSession.create(process.argv[2]!);
console.log("in:", s.inputNames, JSON.stringify(s.inputMetadata));
console.log("out:", s.outputNames, JSON.stringify(s.outputMetadata));
