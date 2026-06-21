// Vite resolves `?url` imports to the emitted asset's URL string. Used to load
// the pdfjs worker lazily (pdfjs-dist/build/pdf.worker.min.mjs?url).
declare module "*?url" {
  const src: string;
  export default src;
}
