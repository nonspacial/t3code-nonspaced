import basisTranscoder from "three/addons/libs/basis/basis_transcoder.js?url";
import basisTranscoderWasm from "three/addons/libs/basis/basis_transcoder.wasm?url";
import dracoDecoderWasm from "three/addons/libs/draco/draco_decoder.wasm?url";
import dracoWrapper from "three/addons/libs/draco/draco_wasm_wrapper.js?url";

/**
 * three's Draco and Basis decoders, which the web app serves beside itself under hashed names.
 * Only their URLs are in the bundle: a decoder is fetched the first time a glTF needs it.
 */
export const MODEL_DECODER_FILES: Readonly<Record<string, string>> = {
  "draco_wasm_wrapper.js": dracoWrapper,
  "draco_decoder.wasm": dracoDecoderWasm,
  "basis_transcoder.js": basisTranscoder,
  "basis_transcoder.wasm": basisTranscoderWasm,
};
