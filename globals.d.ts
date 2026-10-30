// What the page's scripts find on window besides the DOM's own, for TypeScript (tsconfig.json): the theme
// chooser theme.js, a classic script, hands to the modules, and the audio context Safari before 14.1 named
// webkitAudioContext.
interface Window {
  chooseTheme(choice: string): boolean;
  webkitAudioContext?: typeof AudioContext;
}
