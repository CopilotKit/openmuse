/**
 * Minimal typings for `qrcode-generator` (MIT, kazuhikoarase).
 * The package ships without types; this declaration covers exactly the
 * surface used to render the WhatsApp pairing QR in connectors/whatsapp.tsx.
 */
declare module "qrcode-generator" {
  export interface QRCode {
    addData(data: string, mode?: "Byte" | "Numeric" | "Alphanumeric" | "Kanji"): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  export default function qrcode(
    typeNumber: 0,
    errorCorrectionLevel: "L" | "M" | "Q" | "H",
  ): QRCode;
}
