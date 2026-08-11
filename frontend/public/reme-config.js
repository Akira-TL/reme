// Optional deployment-time public configuration.
// A VPS mounts a complete object here; local/Vercel builds keep null and use
// the existing VITE_* values or privacy-preserving loopback defaults.
globalThis.__REME_PUBLIC_CONFIG__ ??= null;
