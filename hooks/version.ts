// The version of the code that is running, shown at the panel's top-right edge. It is loaded with the mod, never read from
// plugin.json at run time (after an update without a reload that would name the new version for the old code). Every
// release changes it together with `.claude-plugin/plugin.json`; tests/version.test.tsx fails when the two differ.
export const VERSION = '1.0.0055'
