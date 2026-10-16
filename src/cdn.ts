/*
 * Data the helper models fetch from jsDelivr when first used, at pinned
 * versions (a commit or an exact npm version), so the bytes cannot change
 * under the widget. Code never comes from here: runtimes are in vendor/.
 */
/** OCR languages (eng, deu), LSTM models: tessdata at a fixed commit. */
export const TESSDATA = "https://cdn.jsdelivr.net/gh/naptha/tessdata@806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_best_int";
/** The voice's phoneme data (espeak-ng), 17 MB. */
export const PIPER_DATA = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data";
