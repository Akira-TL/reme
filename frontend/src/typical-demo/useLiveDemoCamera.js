// Compatibility for the existing single-page demo. New Monitor code should import
// useLiveVideoSource directly to select camera, display, or local-file sources.
export {
  useLiveVideoSource,
  useLiveVideoSource as useLiveDemoCamera,
} from "./useLiveVideoSource";
