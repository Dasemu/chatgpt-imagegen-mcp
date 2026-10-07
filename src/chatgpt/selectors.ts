// The only module that knows the chatgpt.com DOM. Every constant is an ordered list of
// alternatives, most stable first. When the UI changes, add the new selector at the front.

export const COMPOSER = [
  "#prompt-textarea",
  'div[contenteditable="true"][id="prompt-textarea"]',
  'div.ProseMirror[contenteditable="true"]',
  'textarea[data-id="root"]',
  'div[contenteditable="true"]',
];

export const SEND_BUTTON = [
  'button[data-testid="send-button"]',
  "button#composer-submit-button",
  'button[aria-label="Send prompt"]',
  'button[aria-label="Enviar mensaje"]',
  'button[aria-label="Enviar solicitud"]',
];

export const STOP_BUTTON = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Detener la generación"]',
  'button[aria-label="Detener streaming"]',
];

export const FILE_INPUT = [
  'input[type="file"][accept*="image"]',
  'input[type="file"]',
];

export const ATTACHMENT_IN_PROGRESS = [
  'div[data-testid="attachment-upload-progress"]',
  '[role="progressbar"]',
];

export const ASSISTANT_MESSAGE = [
  'div[data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn-"] div[data-message-author-role="assistant"]',
  "div.agent-turn",
];

// Images inside these containers were uploaded by us (references), never generated output.
export const USER_MESSAGE = [
  'div[data-message-author-role="user"]',
  'article[data-turn="user"]',
];

export const LOGIN_MARKERS = [
  'button[data-testid="login-button"]',
  'a[href*="/auth/login"]',
  'button[data-testid="signup-button"]',
  'form[action*="/api/auth/signin"]',
];

// Never add the composer here: chatgpt.com also renders it for logged-out guests.
export const LOGGED_IN_MARKERS = [
  'button[data-testid="profile-button"]',
  'div[data-testid="accounts-profile-button"]',
  'nav[aria-label="Chat history"]',
  'nav[aria-label="Historial de chats"]',
];

export const DISMISS_BUTTONS = [
  'button[data-testid="close-button"]',
  'div[role="dialog"] button[data-testid="dismiss-button"]',
  'div[role="dialog"] button[aria-label="Close"]',
  'div[role="dialog"] button[aria-label="Cerrar"]',
];

export const ERROR_BANNER = [
  'div[role="alert"]',
  "div.text-token-text-error",
  'div[data-testid="error-banner"]',
];

export const USAGE_LIMIT_TEXTS = [
  "you've reached our limit of messages",
  "you have reached our limit of messages",
  "you've hit the limit",
  "you've hit the plus plan limit",
  "image generation limit",
  "you can create images again",
  "usage limit",
  "has alcanzado el límite",
  "límite de mensajes",
  "límite de uso",
  "límite de generación de imágenes",
  "no puedes generar más imágenes",
  "podrás crear imágenes de nuevo",
];

export const TRANSIENT_ERROR_TEXTS = [
  "something went wrong",
  "network error",
  "i wasn't able to generate",
  "i'm unable to generate",
  "se ha producido un error",
  "ha ocurrido un error",
  "error de red",
  "no he podido generar",
];

export const CONTENT_POLICY_TEXTS = [
  "content policy",
  "content policies",
  "violate our",
  "política de contenido",
  "políticas de contenido",
  "infringir nuestras",
];

// Shown while the image is still being rendered (the preview is a blurred partial image).
export const IMAGE_IN_PROGRESS_TEXTS = [
  "creating image",
  "generating image",
  "creando imagen",
  "generando imagen",
];
