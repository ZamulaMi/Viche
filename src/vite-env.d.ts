/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Власний TURN (coturn): "turn:host:3478" або список через кому */
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  /** "true" — примусово ТІЛЬКИ relay через власний TURN */
  readonly VITE_RELAY_ONLY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
