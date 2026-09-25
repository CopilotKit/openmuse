/**
 * Web-only slim scrollbar styling, injected into the global layout stylesheet
 * by ui.tsx's ensureWebStyles().
 *
 * Scroll indicators must stay ENABLED everywhere (the earlier Mac fix removed
 * `showsVerticalScrollIndicator={false}` so scrollbars exist at all) — this
 * module only restyles them: thin, transparent track, rounded thumb, like a
 * normal website. It must never hide scrollbars (`scrollbar-width: none`,
 * `display: none` on scrollbars, transparent-until-hover thumbs, etc. are
 * forbidden here): the thumb is always visible on desktop pointers.
 */
export const WEB_SCROLLBAR_CSS = `
*{scrollbar-width:thin;scrollbar-color:rgba(60,60,67,.32) transparent}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-corner{background:transparent}
*::-webkit-scrollbar-thumb{background-color:rgba(60,60,67,.32);border-radius:8px}
*::-webkit-scrollbar-thumb:hover{background-color:rgba(60,60,67,.55)}
*::-webkit-scrollbar-thumb:active{background-color:rgba(60,60,67,.65)}
`;
