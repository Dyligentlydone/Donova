declare module "onnxruntime-node" {
  export class Tensor {
    constructor(
      type: "float32" | "uint8" | "int32" | "int64",
      data: Float32Array | Uint8Array | Int32Array | BigInt64Array,
      dims: number[],
    );
    readonly data: Float32Array;
    readonly dims: readonly number[];
  }
  export class InferenceSession {
    static create(
      path: string,
      options?: { executionProviders?: string[] },
    ): Promise<InferenceSession>;
    run(
      feeds: Record<string, Tensor>,
    ): Promise<Record<string, Tensor>>;
    inputNames: string[];
    outputNames: string[];
  }
}
