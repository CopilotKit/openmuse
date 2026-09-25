import { useEffect, useId, useRef } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import type { MascotState } from "./mascot-state";

const STATE_SCREEN_DETAILS: Record<
  MascotState,
  {
    line1: string;
    line2: string;
    barWidth: number;
    barColor: string;
    screenFill: string;
    line1Color: string;
    line2Color: string;
  }
> = {
  idle: {
    line1: "> AGENT READY",
    line2: "awaiting input...",
    barWidth: 35,
    barColor: "#94a3b8",
    screenFill: "#cbc5dc",
    line1Color: "#374151",
    line2Color: "#4b5563",
  },
  listening: {
    line1: "> LISTENING...",
    line2: "recording prompt",
    barWidth: 25,
    barColor: "#3b82f6",
    screenFill: "#dbeafe",
    line1Color: "#1e40af",
    line2Color: "#2563eb",
  },
  thinking: {
    line1: "> THINKING...",
    line2: "evaluating plan",
    barWidth: 65,
    barColor: "#8b5cf6",
    screenFill: "#ddd6fe",
    line1Color: "#5b21b6",
    line2Color: "#6d28d9",
  },
  searching: {
    line1: "> SEARCHING...",
    line2: "scanning web/files",
    barWidth: 50,
    barColor: "#0ea5e9",
    screenFill: "#bae6fd",
    line1Color: "#075985",
    line2Color: "#0284c7",
  },
  reading: {
    line1: "> READING...",
    line2: "parsing content",
    barWidth: 70,
    barColor: "#f59e0b",
    screenFill: "#fef3c7",
    line1Color: "#78350f",
    line2Color: "#92400e",
  },
  pdf_review: {
    line1: "> PDF REVIEW...",
    line2: "inspecting pages",
    barWidth: 45,
    barColor: "#ea580c",
    screenFill: "#ffedd5",
    line1Color: "#78350f",
    line2Color: "#92400e",
  },
  writing: {
    line1: "> WRITING...",
    line2: "drafting reply",
    barWidth: 60,
    barColor: "#6366f1",
    screenFill: "#ede9fe",
    line1Color: "#3730a3",
    line2Color: "#4338ca",
  },
  coding: {
    line1: "> GENERATING...",
    line2: "const solve = ()",
    barWidth: 92,
    barColor: "#10b981",
    screenFill: "#bbf7d0",
    line1Color: "#065f46",
    line2Color: "#047857",
  },
  uploading: {
    line1: "> UPLOADING...",
    line2: "syncing assets",
    barWidth: 85,
    barColor: "#eab308",
    screenFill: "#fef08a",
    line1Color: "#713f12",
    line2Color: "#854d0e",
  },
  dispatching: {
    line1: "> DISPATCHING...",
    line2: "orchestrating team",
    barWidth: 80,
    barColor: "#6366f1",
    screenFill: "#e0e7ff",
    line1Color: "#3730a3",
    line2Color: "#4338ca",
  },
  delegating: {
    line1: "> DELEGATING...",
    line2: "subagent handoff",
    barWidth: 75,
    barColor: "#8b5cf6",
    screenFill: "#ede9fe",
    line1Color: "#5b21b6",
    line2Color: "#6d28d9",
  },
  awaiting_approval: {
    line1: "> AWAITING REVIEW",
    line2: "check proposal",
    barWidth: 40,
    barColor: "#f59e0b",
    screenFill: "#fef3c7",
    line1Color: "#78350f",
    line2Color: "#92400e",
  },
  restarting_browser: {
    line1: "> RESTARTING...",
    line2: "browser session",
    barWidth: 90,
    barColor: "#0ea5e9",
    screenFill: "#e0f2fe",
    line1Color: "#075985",
    line2Color: "#0284c7",
  },
  clearing_history: {
    line1: "> CLEARING...",
    line2: "wiping history",
    barWidth: 30,
    barColor: "#94a3b8",
    screenFill: "#f1f5f9",
    line1Color: "#374151",
    line2Color: "#4b5563",
  },
  success: {
    line1: "✓ COMPLETE",
    line2: "0 errors · 100% pass",
    barWidth: 164,
    barColor: "#10b981",
    screenFill: "#bbf7d0",
    line1Color: "#065f46",
    line2Color: "#047857",
  },
  error: {
    line1: "✗ ERROR (RETRY)",
    line2: "process failed",
    barWidth: 164,
    barColor: "#ef4444",
    screenFill: "#fecaca",
    line1Color: "#991b1b",
    line2Color: "#b91c1c",
  },
};

/**
 * The Reactive Muse Cat mascot — animated SVG with:
 * - Animated weeping tears in error state
 * - Top pink paws (chin-scratch in thinking, facepalm clutch in error, cheer in success)
 * - Reactive thought spark in thinking
 * - Happy curved eyes in success
 * - Headphone reaction rings pulsing per state
 * - Live interactive laptop screen display with action lines, blinking cursor, and activity bar
 */
export function MuseCat({ size = 80, state = "idle" }: { size?: number; state?: MascotState }) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const u = `mc${rawId}`;
  const clip = `${u}clip`;
  const lEye = `${u}leye`;
  const rEye = `${u}reye`;
  const soft = `${u}soft`;
  const paw = `${u}paw`;
  const tearGlow = `${u}tearglow`;

  const screen = STATE_SCREEN_DETAILS[state] ?? STATE_SCREEN_DETAILS.idle;

  const xml = `<svg viewBox="44 20 400 408" class="mcp-state-${state}" aria-label="Animated Muse cat">
<defs>
<clipPath id="${clip}"><circle cx="244" cy="210" r="182"/></clipPath>
<clipPath id="${lEye}"><ellipse cx="188" cy="194" rx="24" ry="26"/></clipPath>
<clipPath id="${rEye}"><ellipse cx="300" cy="194" rx="24" ry="26"/></clipPath>
<filter id="${soft}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#a59eb1" flood-opacity=".18"/></filter>
<filter id="${paw}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#857f91" flood-opacity=".22"/></filter>
<filter id="${tearGlow}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#3b82f6" flood-opacity=".35"/></filter>
</defs>

<!-- Outer circular frame -->
<circle cx="244" cy="210" r="182" fill="#f8f6fa" stroke="#d7d3da" stroke-width="3"/>
<ellipse cx="244" cy="390" rx="190" ry="18" fill="#ece8ef" opacity=".55"/>

<g clip-path="url(#${clip})">
  <g class="mcp-cat-all">
    <!-- Ears -->
    <g class="mcp-ears">
      <g class="mcp-ear-l">
        <path d="M138 122 C132 80, 156 53, 188 58 C204 60, 210 94, 208 136 Z" fill="#dddddf"/>
        <path d="M156 122 C152 93, 169 72, 189 75 C199 76, 204 98, 202 125 Z" fill="#f8ccd6"/>
      </g>
      <g class="mcp-ear-r">
        <path d="M350 122 C356 80, 332 53, 300 58 C284 60, 278 94, 280 136 Z" fill="#dddddf"/>
        <path d="M332 122 C336 93, 319 72, 299 75 C289 76, 284 98, 286 125 Z" fill="#f8ccd6"/>
      </g>
    </g>

    <!-- Headphone headband -->
    <path d="M135 138 C152 88, 197 62, 244 62 C291 62, 336 88, 353 138" fill="none" stroke="#8fd0cb" stroke-width="18" stroke-linecap="round"/>

    <!-- Head & body fluff -->
    <ellipse cx="244" cy="210" rx="123" ry="116" fill="#fbfbfc" filter="url(#${soft})"/>
    <path d="M122 190 C123 132, 171 93, 244 93 C317 93, 365 132, 366 190 C355 165, 331 140, 244 140 C157 140, 133 165, 122 190Z" fill="#d7d4dc"/>
    <ellipse cx="244" cy="280" rx="144" ry="102" fill="#fbfbfc"/>
    <ellipse cx="244" cy="302" rx="114" ry="72" fill="#fefefe"/>

    <!-- Headphones with reactive glowing rings -->
    <g class="mcp-headphones">
      <g>
        <rect x="94" y="147" width="48" height="86" rx="24" fill="#8fd0cb"/>
        <rect x="104" y="151" width="34" height="78" rx="17" fill="#f7f0e8"/>
        <ellipse cx="121" cy="190" rx="11" ry="24" fill="none" stroke="#8fd0cb" stroke-width="3" class="mcp-headphone-ring"/>
      </g>
      <g>
        <rect x="346" y="147" width="48" height="86" rx="24" fill="#8fd0cb"/>
        <rect x="350" y="151" width="34" height="78" rx="17" fill="#f7f0e8"/>
        <ellipse cx="367" cy="190" rx="11" ry="24" fill="none" stroke="#8fd0cb" stroke-width="3" class="mcp-headphone-ring"/>
      </g>
    </g>

    <!-- Brows -->
    <path class="mcp-brow-l" d="M168 156 C176 149, 186 149, 194 156" fill="none" stroke="#908993" stroke-width="4" stroke-linecap="round"/>
    <path class="mcp-brow-r" d="M294 156 C302 149, 312 149, 320 156" fill="none" stroke="#908993" stroke-width="4" stroke-linecap="round"/>

    <!-- Normal Eyes Layer -->
    <g class="mcp-normal-eyes">
      <ellipse cx="188" cy="194" rx="24" ry="26" fill="#ffffff"/>
      <ellipse cx="300" cy="194" rx="24" ry="26" fill="#ffffff"/>
      <g clip-path="url(#${lEye})">
        <g class="mcp-pupil-l">
          <circle cx="188" cy="195" r="13.5" fill="#19161d"/>
          <circle cx="194" cy="189" r="4.6" fill="#ffffff"/>
        </g>
      </g>
      <g clip-path="url(#${rEye})">
        <g class="mcp-pupil-r">
          <circle cx="300" cy="195" r="13.5" fill="#19161d"/>
          <circle cx="306" cy="189" r="4.6" fill="#ffffff"/>
        </g>
      </g>
      <rect class="mcp-lid-l" x="160" y="166" width="56" height="0" rx="16" fill="#fbfbfc"/>
      <rect class="mcp-lid-r" x="272" y="166" width="56" height="0" rx="16" fill="#fbfbfc"/>
    </g>

    <!-- Happy Eyes for Success -->
    <g class="mcp-happy-eyes">
      <path d="M168 198 C176 182, 198 182, 206 198" fill="none" stroke="#25212b" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M280 198 C288 182, 310 182, 318 198" fill="none" stroke="#25212b" stroke-width="4.5" stroke-linecap="round"/>
    </g>

    <!-- Soft Cheek Blush -->
    <ellipse cx="152" cy="225" rx="18" ry="12" fill="#fbe4ec" opacity=".7"/>
    <ellipse cx="336" cy="225" rx="18" ry="12" fill="#fbe4ec" opacity=".7"/>

    <!-- Muzzle & Mouth -->
    <ellipse cx="244" cy="220" rx="32" ry="22" fill="#fffafc"/>
    <path d="M230 208 Q244 198 258 208" fill="#f6b0bf"/>
    <path d="M244 209 L244 218" stroke="#7d727c" stroke-width="2" stroke-linecap="round"/>
    <path d="M244 218 C236 228, 230 231, 220 227" fill="none" stroke="#7d727c" stroke-width="3" stroke-linecap="round"/>
    <path d="M244 218 C252 228, 258 231, 268 227" fill="none" stroke="#7d727c" stroke-width="3" stroke-linecap="round"/>

    <!-- Whiskers -->
    <path d="M112 226 C134 220, 154 220, 176 225" fill="none" stroke="#ddd8df" stroke-width="2" stroke-linecap="round"/>
    <path d="M114 238 C132 238, 151 240, 170 245" fill="none" stroke="#ddd8df" stroke-width="2" stroke-linecap="round"/>
    <path d="M376 226 C354 220, 334 220, 312 225" fill="none" stroke="#ddd8df" stroke-width="2" stroke-linecap="round"/>
    <path d="M374 238 C356 238, 337 240, 318 245" fill="none" stroke="#ddd8df" stroke-width="2" stroke-linecap="round"/>

    <!-- Reactive Thought Spark -->
    <g class="mcp-thought-cloud">
      <circle cx="325" cy="85" r="16" fill="#8b5cf6" opacity="0.88"/>
      <path d="M325 75 L328 82 L335 85 L328 88 L325 95 L322 88 L315 85 L322 82 Z" fill="#ffffff"/>
      <circle cx="308" cy="103" r="6" fill="#8b5cf6" opacity="0.6"/>
      <circle cx="296" cy="116" r="3.5" fill="#8b5cf6" opacity="0.4"/>
    </g>

    <!-- ANIMATED TEARS (Error State) -->
    <g class="mcp-tears" filter="url(#${tearGlow})">
      <!-- Left Eye Tears -->
      <g>
        <ellipse cx="174" cy="208" rx="8" ry="5" fill="#60a5fa" opacity="0.9"/>
        <path class="mcp-tear-stream" d="M174 207 C166 220, 160 240, 165 254 C170 264, 180 262, 182 250 C184 236, 180 218, 174 207 Z" fill="#60a5fa" opacity="0.85"/>
        <ellipse cx="172" cy="245" rx="3.5" ry="6" fill="#ffffff" opacity="0.85"/>
        <circle cx="176" cy="225" r="2.2" fill="#ffffff" opacity="0.9"/>
        <path class="mcp-tear-drop mcp-tear-drop-1" d="M170 266 C165 272, 165 281, 170 283 C175 285, 178 279, 174 272 Z" fill="#93c5fd"/>
      </g>
      <!-- Right Eye Tears -->
      <g>
        <ellipse cx="314" cy="208" rx="8" ry="5" fill="#60a5fa" opacity="0.9"/>
        <path class="mcp-tear-stream" d="M314 207 C322 220, 328 240, 323 254 C318 264, 308 262, 306 250 C304 236, 308 218, 314 207 Z" fill="#60a5fa" opacity="0.85"/>
        <ellipse cx="316" cy="245" rx="3.5" ry="6" fill="#ffffff" opacity="0.85"/>
        <circle cx="312" cy="225" r="2.2" fill="#ffffff" opacity="0.9"/>
        <path class="mcp-tear-drop mcp-tear-drop-2" d="M318 266 C323 272, 323 281, 318 283 C313 285, 310 279, 314 272 Z" fill="#93c5fd"/>
      </g>
    </g>

    <!-- Top Pink Paws -->
    <g class="mcp-top-paws">
      <g class="mcp-top-paw-l" filter="url(#${paw})">
        <ellipse cx="146" cy="240" rx="26" ry="19" fill="#fafafd"/>
        <ellipse cx="146" cy="241" rx="15" ry="11" fill="#f6cad5"/>
        <circle cx="136" cy="230" r="4.2" fill="#f6cad5"/>
        <circle cx="146" cy="227" r="4.6" fill="#f6cad5"/>
        <circle cx="156" cy="230" r="4.2" fill="#f6cad5"/>
      </g>
      <g class="mcp-top-paw-r" filter="url(#${paw})">
        <ellipse cx="342" cy="240" rx="26" ry="19" fill="#fafafd"/>
        <ellipse cx="342" cy="241" rx="15" ry="11" fill="#f6cad5"/>
        <circle cx="332" cy="230" r="4.2" fill="#f6cad5"/>
        <circle cx="342" cy="227" r="4.6" fill="#f6cad5"/>
        <circle cx="352" cy="230" r="4.2" fill="#f6cad5"/>
      </g>
    </g>
  </g>

  <!-- Laptop with Dynamic Screen Color & Interactive Display -->
  <g class="mcp-laptop">
    <rect x="145" y="268" width="198" height="118" rx="18" fill="#c9c3da" filter="url(#${soft})"/>
    <rect class="mcp-laptop-screen" x="150" y="273" width="188" height="108" rx="16" fill="${screen.screenFill}"/>
    <rect class="mcp-glow" x="160" y="282" width="168" height="12" rx="6" fill="#ffffff" opacity="0.25"/>

    <g class="mcp-screen-display">
      <!-- Window control dots -->
      <circle cx="164" cy="285" r="2.8" fill="#f87171" opacity="0.85"/>
      <circle cx="172" cy="285" r="2.8" fill="#fbbf24" opacity="0.85"/>
      <circle cx="180" cy="285" r="2.8" fill="#34d399" opacity="0.85"/>

      <!-- Action Line 1 -->
      <text class="mcp-screen-line1" x="162" y="306" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700" fill="${screen.line1Color}" letter-spacing="-0.02em">
        ${screen.line1}
      </text>

      <!-- Action Line 2 with Blinking Cursor -->
      <text class="mcp-screen-line2" x="162" y="322" font-family="ui-monospace, monospace" font-size="8.5" font-weight="600" fill="${screen.line2Color}" letter-spacing="-0.01em">
        ${screen.line2}<tspan class="mcp-screen-cursor">_</tspan>
      </text>

      <!-- Mini Progress / Activity Bar -->
      <g>
        <rect x="162" y="331" width="164" height="4" rx="2" fill="#a78bfa" opacity="0.3"/>
        <rect class="mcp-screen-progress" x="162" y="331" width="${screen.barWidth}" height="4" rx="2" fill="${screen.barColor}" opacity="0.85"/>
      </g>
    </g>
  </g>

  <!-- Keyboard Deck -->
  <g class="mcp-keyboard">
    <path d="M128 374 H360 L382 420 H106 Z" fill="#b7b0c8" filter="url(#${soft})"/>
    <path d="M139 382 H349 L364 411 H123 Z" fill="#9f98b4"/>
    <g opacity=".9" fill="#777087">
      <rect x="143" y="387" width="19" height="7" rx="2"/><rect x="166" y="387" width="19" height="7" rx="2"/><rect x="189" y="387" width="19" height="7" rx="2"/><rect x="212" y="387" width="19" height="7" rx="2"/><rect x="235" y="387" width="19" height="7" rx="2"/><rect x="258" y="387" width="19" height="7" rx="2"/><rect x="281" y="387" width="19" height="7" rx="2"/><rect x="304" y="387" width="19" height="7" rx="2"/>
      <rect x="151" y="398" width="20" height="7" rx="2"/><rect x="175" y="398" width="20" height="7" rx="2"/><rect x="199" y="398" width="20" height="7" rx="2"/><rect x="223" y="398" width="20" height="7" rx="2"/><rect x="247" y="398" width="20" height="7" rx="2"/><rect x="271" y="398" width="20" height="7" rx="2"/><rect x="295" y="398" width="20" height="7" rx="2"/><rect x="319" y="398" width="20" height="7" rx="2"/>
    </g>
    <rect x="210" y="410" width="68" height="6" rx="3" fill="#8d86a2"/>
  </g>

  <!-- Bottom Typing Paws -->
  <g class="mcp-bottom-paws">
    <g class="mcp-paw-l" filter="url(#${paw})">
      <ellipse cx="168" cy="381" rx="36" ry="28" fill="#fafafd"/>
      <ellipse cx="168" cy="388" rx="20" ry="12" fill="#f0ebf3"/>
      <path d="M154 389 Q160 382 166 389 M168 389 Q174 382 180 389" fill="none" stroke="#ded8e3" stroke-width="2.3" stroke-linecap="round"/>
    </g>
    <g class="mcp-paw-r" filter="url(#${paw})">
      <ellipse cx="320" cy="381" rx="36" ry="28" fill="#fafafd"/>
      <ellipse cx="320" cy="388" rx="20" ry="12" fill="#f0ebf3"/>
      <path d="M306 389 Q312 382 318 389 M320 389 Q326 382 332 389" fill="none" stroke="#ded8e3" stroke-width="2.3" stroke-linecap="round"/>
    </g>
  </g>

  <!-- Success Sparkles -->
  <g class="mcp-sparkles">
    <g class="mcp-sp"><path d="M100 96 L105 108 L117 113 L105 118 L100 130 L95 118 L83 113 L95 108 Z" fill="#8fd0cb"/></g>
    <g class="mcp-sp"><path d="M376 96 L381 108 L393 113 L381 118 L376 130 L371 118 L359 113 L371 108 Z" fill="#f3bcd0"/></g>
    <g class="mcp-sp"><path d="M244 62 L248 72 L258 76 L248 80 L244 90 L240 80 L230 76 L240 72 Z" fill="#f4d59d"/></g>
  </g>
</g>
</svg>`;

  const container = useRef<View>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const root = container.current as unknown as Element | null;
    const host = root?.querySelector?.("svg") ?? null;
    if (!host) return;

    const leftWrap = host.querySelector(".mcp-pupil-l");
    const rightWrap = host.querySelector(".mcp-pupil-r");
    const leftLid = host.querySelector(".mcp-lid-l");
    const rightLid = host.querySelector(".mcp-lid-r");
    if (!leftWrap || !rightWrap || !leftLid || !rightLid) return;

    const lw: Element = leftWrap;
    const rw: Element = rightWrap;
    const ll: Element = leftLid;
    const rl: Element = rightLid;

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    function target(s: MascotState, t: number): { x: number; y: number } {
      switch (s) {
        case "idle":
          return { x: Math.sin(t * 0.85) * 1.8, y: Math.cos(t * 0.6) * 1.1 };
        case "listening":
          return { x: 0, y: -2.8 };
        case "thinking":
          return { x: 4.2 + Math.cos(t * 1.8) * 1.4, y: -5.8 + Math.sin(t * 2.2) * 1.6 };
        case "searching":
          return { x: Math.sin(t * 5.2) * 8.0, y: Math.sin(t * 2.2) * 0.8 };
        case "reading":
          return { x: Math.sin(t * 2.1) * 5.5, y: 5.6 };
        case "pdf_review":
          return { x: Math.sin(t * 3.1) * 6.6, y: 4.8 + Math.cos(t * 1.4) * 0.8 };
        case "writing":
          return { x: 1.4 + Math.sin(t * 5.2) * 0.9, y: 5.8 };
        case "coding":
          return { x: Math.sin(t * 9.3) * 5.2, y: Math.cos(t * 2.4) * 1.0 + 2.5 };
        case "uploading":
          return { x: 0, y: -6.2 + Math.sin(t * 2.4) * 0.8 };
        case "dispatching":
          return { x: Math.sin(t * 6.1) * 7.5, y: Math.cos(t * 3.0) * 1.2 };
        case "delegating":
          return { x: 2.2 + Math.sin(t * 4.4) * 1.1, y: 5.4 };
        case "awaiting_approval":
          return { x: -2.5 + Math.sin(t * 0.9) * 0.8, y: -4.6 };
        case "restarting_browser":
          return { x: Math.sin(t * 11.2) * 6.0, y: Math.cos(t * 5.6) * 2.0 };
        case "clearing_history":
          return { x: Math.sin(t * 3.4) * 4.0, y: 3.0 + Math.cos(t * 1.7) * 1.5 };
        case "success":
          return { x: 0, y: 0 };
        case "error":
          return { x: 4.5 * Math.sign(Math.sin(t * 9.5)), y: 1.5 + Math.sin(t * 8) * 1.2 };
        default:
          return { x: 0, y: 0 };
      }
    }

    let raf = 0;
    let currentX = 0;
    let currentY = 0;
    let blink = 0;
    let blinkTarget = 0;
    let lastBlinkAt = 0;

    function frame(now: number) {
      const t = now / 1000;
      const s = stateRef.current;
      const goal = target(s, t);
      currentX += (goal.x - currentX) * 0.13;
      currentY += (goal.y - currentY) * 0.13;
      const ex = clamp(currentX, -9, 9);
      const ey = clamp(currentY, -8, 8);
      lw.setAttribute("transform", `translate(${ex.toFixed(2)} ${ey.toFixed(2)})`);
      rw.setAttribute("transform", `translate(${ex.toFixed(2)} ${ey.toFixed(2)})`);

      const minGap =
        s === "thinking" || s === "coding"
          ? 2500
          : s === "error"
            ? 1600
            : s === "awaiting_approval"
              ? 5200
              : 3400;
      if (now - lastBlinkAt > minGap) {
        if (Math.random() < 0.025) {
          lastBlinkAt = now;
          blinkTarget = 1;
        }
      }
      if (blinkTarget > 0) {
        blink += (1 - blink) * 0.38;
        if (blink > 0.95) blinkTarget = 0;
      } else {
        blink += (0 - blink) * 0.28;
      }
      const lidH = (54 * blink).toFixed(2);
      ll.setAttribute("height", lidH);
      rl.setAttribute("height", lidH);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <View
      ref={container}
      accessibilityLabel="Muse cat"
      style={{
        width: size,
        height: Math.round(size * 1.02),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <SvgXml xml={xml} width={size} height={Math.round(size * 1.02)} />
    </View>
  );
}
