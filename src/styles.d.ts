// The Expo template ships stylesheets imported as modules; TypeScript has no built-in mapping
// for them, so the side-effect imports resolve here instead of failing the typecheck.
declare module '*.css';
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
