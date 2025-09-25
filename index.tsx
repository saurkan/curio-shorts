/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, Modality, Type} from '@google/genai';
import {marked} from 'marked';

// --- Interfaces ---
interface SlideData {
  lyrics: string;
  imageSrc: string;
}

interface SongSlide {
  lyrics: string;
  image_prompt: string;
}

interface SongStructure {
  slides: SongSlide[];
  music_style: string;
}

interface TikTok {
  id: string;
  slides: SlideData[];
  character: string;
  prompt: string;
  instrumentalId: string | null;
  voiceName?: string; // For browser TTS
  element?: HTMLElement;
}

// --- DOM Elements ---
let ai: GoogleGenAI;
const userInput = document.querySelector('#input') as HTMLTextAreaElement;
const slideshow = document.querySelector('#slideshow') as HTMLDivElement;
const error = document.querySelector('#error') as HTMLDivElement;
const characterSelector = document.querySelector(
  '#character-selector',
) as HTMLSelectElement;
const customCharacterInput = document.querySelector(
  '#custom-character-input',
) as HTMLInputElement;
const shortsStyleSelector = document.querySelector(
  '#shorts-style-selector',
) as HTMLDivElement;
const voiceSelector = document.querySelector(
  '#voice-selector',
) as HTMLSelectElement;
const examplesSelector = document.querySelector(
  '#examples-selector',
) as HTMLSelectElement;
const initialMessage = document.querySelector(
  '#initial-message',
) as HTMLDivElement;
const generateBtn = document.querySelector('#generate-btn') as HTMLButtonElement;
const historyGallery = document.querySelector(
  '#history-gallery',
) as HTMLDivElement;
const themeToggle = document.querySelector('#theme-toggle') as HTMLButtonElement;

// Modal Elements
const modalOverlay = document.querySelector('#modal-overlay') as HTMLDivElement;
const errorModal = document.querySelector('#error-modal') as HTMLDivElement;
const errorModalMessage = document.querySelector(
  '#error-modal-message',
) as HTMLParagraphElement;
const closeErrorModalBtn = document.querySelector(
  '#close-error-modal-btn',
) as HTMLButtonElement;

// API Key Modal Elements
const addApiBtn = document.querySelector('#add-api-btn') as HTMLButtonElement;
const apiKeyModal = document.querySelector('#api-key-modal') as HTMLDivElement;
const apiKeyInput = document.querySelector('#api-key-input') as HTMLInputElement;
const saveApiKeyBtn = document.querySelector(
  '#save-api-key-btn',
) as HTMLButtonElement;
const closeApiKeyModalBtn = document.querySelector(
  '#close-api-key-modal-btn',
) as HTMLButtonElement;

// --- State Management ---
let isPlaying = false;
let isGenerating = false;
let selectedStyle = 'storybook';
let savedTikToks: TikTok[] = [];
let tiktokObserver: IntersectionObserver;
let slideObserver: IntersectionObserver | null = null;
let activeTikTokContainer: HTMLElement | null = null;
let currentAudio: HTMLAudioElement | null = null;
let backgroundAudio: HTMLAudioElement | null = null;

// --- Database Management ---
const DB_NAME = 'TikTokForLearningDB';
const DB_VERSION = 1;
const STORE_NAME = 'tiktoks';
let db: IDBDatabase;

// --- Initialization ---
init();

async function init() {
  try {
    await initDB();
    initializeGenAI();
    setupEventListeners();
    setupTikTokObserver();
    await loadHistoryFromDB();
    setupTheme();
    populateVoices(); // Populate voices initially
    speechSynthesis.onvoiceschanged = populateVoices; // and when they load
  } catch (e) {
    console.error('Initialization failed:', e);
    showErrorPopup('Application failed to start. Could not access storage.');
  }
}

// --- Data Persistence (IndexedDB) ---

function initDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const dbInstance = request.result;
      if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
        dbInstance.createObjectStore(STORE_NAME, {keyPath: 'id'});
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve();
    };

    request.onerror = () => {
      console.error('IndexedDB error:', request.error);
      reject(new Error('Failed to open IndexedDB.'));
    };
  });
}

function saveTikTokToDB(tiktok: TikTok): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database is not initialized.'));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {element, ...savableTikTok} = tiktok;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(savableTikTok);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Failed to save TikTok to DB:', request.error);
      reject(request.error);
    };
  });
}

async function loadHistoryFromDB() {
  if (!db) {
    console.error('Database is not initialized.');
    return;
  }
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const request = store.getAll();

  return new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const loadedTikToks = request.result as TikTok[];
      // Sort by ID (timestamp) descending to get newest first
      loadedTikToks.sort((a, b) => Number(b.id) - Number(a.id));
      savedTikToks = loadedTikToks;

      if (savedTikToks.length > 0) {
        initialMessage.setAttribute('hidden', 'true');
        slideshow.removeAttribute('hidden');
        // Add to feed in reverse order of the now newest-first array,
        // so that prepend() correctly places the newest item at the top.
        [...savedTikToks].reverse().forEach(addTikTokToFeed);
        renderHistoryGallery();
      }
      resolve();
    };
    request.onerror = () => {
      console.error('Failed to load history from DB:', request.error);
      reject(request.error);
    };
  });
}

// --- API Key Management ---

const API_KEY_STORAGE_KEY = 'gemini_api_key';

function getApiKey(): string | undefined {
  const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (storedKey) {
    return storedKey;
  }
  // The API key is provided by the AI Studio environment.
  // This will be undefined if the app is hosted elsewhere.
  return process.env.API_KEY;
}

function initializeGenAI() {
  const apiKey = getApiKey();
  if (apiKey) {
    try {
      ai = new GoogleGenAI({apiKey});
    } catch (e) {
      ai = undefined;
      showErrorPopup(`Failed to initialize Gemini Client: ${String(e)}`);
    }
  } else {
    ai = undefined;
    // Don't show an error on startup, but prompt them to add a key.
    console.warn('Gemini API key not found. Please add one using the settings.');
  }
}

// --- UI & Voice Population ---
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voiceSelector) return;

  voiceSelector.innerHTML = ''; // Clear existing voices
  voices
    .filter((voice) => voice.lang.startsWith('en')) // Filter for English voices
    .forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelector.appendChild(option);
    });
}

// --- Modal Controls ---
function showErrorPopup(message: string) {
  errorModalMessage.textContent = message;
  modalOverlay.classList.remove('hidden');
  errorModal.classList.remove('hidden');
}

function closeErrorPopup() {
  modalOverlay.classList.add('hidden');
  errorModal.classList.add('hidden');
}

function openApiKeyModal() {
  apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  modalOverlay.classList.remove('hidden');
  apiKeyModal.classList.remove('hidden');
}

function closeApiKeyModal() {
  modalOverlay.classList.add('hidden');
  apiKeyModal.classList.add('hidden');
}

async function handleSaveApiKey() {
  const newKey = apiKeyInput.value.trim();
  if (newKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, newKey);
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
  closeApiKeyModal();
  // Re-initialize the client with the new key or lack thereof
  initializeGenAI();
}

// --- Core Generation Functions ---

function selectBeatForStyle(style: string): string {
  const lowerStyle = style.toLowerCase();
  if (
    lowerStyle.includes('upbeat') ||
    lowerStyle.includes('pop') ||
    lowerStyle.includes('happy') ||
    lowerStyle.includes('rock')
  ) {
    return 'beat-upbeat';
  } else if (
    lowerStyle.includes('ballad') ||
    lowerStyle.includes('gentle') ||
    lowerStyle.includes('slow') ||
    lowerStyle.includes('acoustic')
  ) {
    return 'beat-ballad';
  } else if (
    lowerStyle.includes('epic') ||
    lowerStyle.includes('cinematic') ||
    lowerStyle.includes('score')
  ) {
    return 'beat-epic';
  }
  return 'beat-upbeat'; // Default fallback
}

const STYLE_PROMPTS: Record<string, string> = {
  anime:
    'In the style of modern vibrant anime, detailed characters and backgrounds, cinematic lighting:',
  comic:
    'In the style of a classic American comic book, with bold lines, Ben-Day dots, and a dynamic panel layout:',
  photoreal: 'A photorealistic, high-detail, cinematic 4K photo:',
  storybook:
    "A whimsical and charming children's storybook illustration, with soft textures and a warm color palette:",
  retro:
    'In the style of 16-bit pixel art, vibrant color palette, reminiscent of a classic SNES RPG game:',
  cinematic:
    'A cinematic movie still, dramatic lighting, epic scope, high detail, wide-angle shot:',
};

async function generateImageFromPrompt(prompt: string): Promise<string> {
  const stylePrefix = STYLE_PROMPTS[selectedStyle] || '';
  const finalPrompt = `${stylePrefix} A 9:16 aspect ratio image of: ${prompt}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image-preview',
    contents: {
      parts: [{text: finalPrompt}],
    },
    config: {
      responseModalities: [Modality.IMAGE, Modality.TEXT],
    },
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData && part.inlineData.data) {
      const base64ImageBytes: string = part.inlineData.data;
      return `data:${part.inlineData.mimeType};base64,${base64ImageBytes}`;
    }
  }

  throw new Error('Image generation failed. The model did not return an image.');
}

function getInstructionsForSong(character: string): string {
  const baseInstructions = `
    You are a creative songwriter and visual artist.
    Your task is to create a short, catchy, and simple song that explains the user's query.
    The song must be from the perspective of the specified character.
    Generate a response in JSON format.
    The JSON object must contain two keys:
    1. "slides": An array of slide objects, where each slide contains a short line of "lyrics" and a corresponding descriptive "image_prompt" for an illustration to match that line.
    2. "music_style": A short string describing the musical style of the song (e.g., "upbeat pop", "gentle acoustic ballad", "epic cinematic score").
    Do NOT include any text, words, or letters in the image prompt itself.
    The song should have between 6 and 8 slides.
    No commentary, just the JSON object.`;

  const emojiRegex = /^\p{Emoji}\s*/u;
  const logicName = character.replace(emojiRegex, '').trim();
  const characterNameForPrompt =
    logicName.charAt(0).toUpperCase() + logicName.slice(1);

  let characterSpecifics = '';
  switch (logicName.toLowerCase()) {
    case 'spider-man':
      characterSpecifics =
        'Use concepts like web-slinging, spider-sense, and great responsibility in the lyrics.';
      break;
    case 'barbie':
      characterSpecifics =
        'Use themes of fashion, friendship, and her many careers in the lyrics.';
      break;
    case 'simba':
      characterSpecifics =
        'Use themes of the circle of life, the pride lands, and his jungle friends in the lyrics.';
      break;
    default:
      characterSpecifics = `Incorporate ${characterNameForPrompt}'s unique personality, skills, and famous concepts into the lyrics.`;
  }

  return `${baseInstructions} ${characterSpecifics}`;
}

async function generate() {
  const message = userInput.value.trim();
  const voiceChoice = voiceSelector.value;
  if (!message || isGenerating) return;

  if (!ai) {
    showErrorPopup(
      'The Gemini client is not initialized. Please add your Gemini API key using the key icon in the header.',
    );
    return;
  }

  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  stopSlideshow();

  error.innerHTML = '';
  error.toggleAttribute('hidden', true);
  initialMessage.setAttribute('hidden', 'true');
  slideshow.removeAttribute('hidden');

  try {
    const customCharacter = customCharacterInput.value.trim();
    let finalCharacter = characterSelector.value;
    if (finalCharacter === 'custom') {
      finalCharacter = customCharacter;
    }

    if (!finalCharacter) {
      showErrorPopup('Please enter or select a narrator.');
      return;
    }

    const instructions = getInstructionsForSong(finalCharacter);

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `${message}\n${instructions}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            slides: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lyrics: {type: Type.STRING},
                  image_prompt: {type: Type.STRING},
                },
              },
            },
            music_style: {type: Type.STRING},
          },
        },
      },
    });

    const songData = JSON.parse(result.text) as SongStructure;
    if (!songData || !songData.slides || songData.slides.length === 0) {
      throw new Error('Could not generate song structure from model.');
    }

    const songStructure = songData.slides;
    const musicStyle = songData.music_style || 'a catchy song';
    const instrumentalId = selectBeatForStyle(musicStyle);

    // --- Start background music immediately ---
    if (backgroundAudio) {
      backgroundAudio.pause();
    }
    const newBackgroundAudio = document.querySelector(
      `#${instrumentalId}`,
    ) as HTMLAudioElement | null;
    if (newBackgroundAudio) {
      backgroundAudio = newBackgroundAudio;
      backgroundAudio.currentTime = 0;
      backgroundAudio.volume = 0.3; // A good background level
      backgroundAudio.play().catch((e) => {
        console.error(`Background audio playback failed: ${String(e)}`);
      });
    }

    const imagePrompts = songStructure.map((s) => s.image_prompt);
    let images: string[] = [];

    // --- Image Generation Step ---
    try {
      images = await Promise.all(
        imagePrompts.map((prompt) => generateImageFromPrompt(prompt)),
      );
    } catch (imageError) {
      showErrorPopup(
        `Failed to generate images: ${String(imageError)}. Please try again.`,
      );
      return; // Stop generation
    }

    const newTikTok: TikTok = {
      id: Date.now().toString(),
      slides: songStructure.map((part, index) => ({
        lyrics: part.lyrics,
        imageSrc: images[index],
      })),
      character: finalCharacter,
      prompt: message,
      instrumentalId: instrumentalId,
      voiceName: voiceChoice,
    };

    if (newTikTok.slides.length > 0) {
      await saveAndRenderNewTikTok(newTikTok);
    } else {
      throw new Error('No content was generated. Please try again.');
    }
  } catch (e) {
    showErrorPopup(`Something went wrong: ${String(e)}`);
    if (slideshow.children.length === 0) {
      slideshow.setAttribute('hidden', 'true');
      initialMessage.removeAttribute('hidden');
    }
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Shorts';
    userInput.focus();
  }
}

// --- Rendering & DOM Manipulation ---

async function saveAndRenderNewTikTok(tiktok: TikTok) {
  try {
    // Add to the beginning of the in-memory array (newest-first)
    savedTikToks.unshift(tiktok);
    await saveTikTokToDB(tiktok);
    addTikTokToFeed(tiktok);
    renderHistoryGallery();
    // Scroll the main feed to the top to show the new video
    slideshow.scrollTo({top: 0, behavior: 'smooth'});
  } catch (e) {
    savedTikToks.shift(); // Remove from memory if save fails
    console.error('Failed to save TikTok:', e);
    showErrorPopup(
      'Failed to save your new Short. Storage might be full or corrupted.',
    );
  }
}

function addTikTokToFeed(tiktok: TikTok) {
  const tiktokContainer = document.createElement('div');
  tiktokContainer.className = 'tiktok-item-container';
  tiktokContainer.dataset.tiktokId = tiktok.id;

  const horizontalSlider = document.createElement('div');
  horizontalSlider.className = 'horizontal-slider';

  for (const slideData of tiktok.slides) {
    const slide = createSlideElement(
      slideData,
      tiktok.prompt,
      tiktok.character,
    );
    horizontalSlider.append(slide);
  }

  tiktokContainer.append(horizontalSlider);
  // Prepend to show the newest video at the top of the feed
  slideshow.prepend(tiktokContainer);
  tiktokObserver.observe(tiktokContainer);
  tiktok.element = tiktokContainer;
}

function createSlideElement(
  slideData: SlideData,
  prompt: string,
  character: string,
): HTMLDivElement {
  const slide = document.createElement('div');
  slide.className = 'slide';
  const characterName = character.charAt(0).toUpperCase() + character.slice(1);
  slide.innerHTML = `
    <img src="${slideData.imageSrc}" alt="Generated illustration">
    <div class="slide-content">
       <div class="slide-prompt">
        <span class="creator-name">${characterName}</span>
        ${prompt}
      </div>
      <div class="slide-answer">${marked.parse(slideData.lyrics)}</div>
    </div>
    <div class="slide-actions">
      <button class="action-icon like-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span>Like</span></button>
      <button class="action-icon comment-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2z"/></svg><span>Comment</span></button>
      <button class="action-icon replay-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg><span>Replay</span></button>
    </div>
    <div class="play-pause-overlay"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
  `;
  return slide;
}

function renderHistoryGallery() {
  historyGallery.innerHTML = '';
  if (savedTikToks.length === 0) {
    historyGallery.innerHTML = `<p class="gallery-placeholder">Saved Shorts will appear here.</p>`;
    return;
  }
  // The savedTikToks array is already sorted newest-first.
  for (const tiktok of savedTikToks) {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumbnail';
    thumb.dataset.tiktokId = tiktok.id;
    thumb.innerHTML = `
      <img src="${tiktok.slides[0].imageSrc}" alt="Thumbnail for ${tiktok.prompt}">
      <div class="gallery-prompt">${tiktok.prompt}</div>
    `;
    historyGallery.append(thumb);
  }
}

// --- Observers & Scrolling ---

function setupTikTokObserver() {
  tiktokObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (activeTikTokContainer !== entry.target) {
            stopSlideshow();
            activeTikTokContainer = entry.target as HTMLElement;
            setupSlideObserverForActiveTikTok();
          }
        }
      });
    },
    {root: slideshow, threshold: 0.8},
  );
}

function setupSlideObserverForActiveTikTok() {
  if (slideObserver) slideObserver.disconnect();
  if (!activeTikTokContainer) return;

  const horizontalSlider = activeTikTokContainer.querySelector(
    '.horizontal-slider',
  ) as HTMLElement;
  slideObserver = new IntersectionObserver(
    (entries) => {
      let isAtBounds = false;
      entries.forEach((entry) => {
        const slide = entry.target as HTMLElement;
        slide.classList.toggle('is-visible', entry.isIntersecting);

        if (entry.isIntersecting) {
          const isFirst = !slide.previousElementSibling;
          const isLast = !slide.nextElementSibling;
          if (isFirst || isLast) isAtBounds = true;
        }
      });
      slideshow.style.overflowY = isAtBounds ? 'auto' : 'hidden';
    },
    {root: horizontalSlider, threshold: 0.8},
  );

  horizontalSlider
    .querySelectorAll('.slide')
    .forEach((slide) => slideObserver!.observe(slide));
}

function navigateVertically(direction: 'up' | 'down') {
  if (!activeTikTokContainer) return;
  const target =
    direction === 'up'
      ? (activeTikTokContainer.previousElementSibling as HTMLElement)
      : (activeTikTokContainer.nextElementSibling as HTMLElement);
  target?.scrollIntoView({behavior: 'smooth'});
}

// --- Playback Controls ---
function startSlideshow() {
  if (!activeTikTokContainer) return;
  const tiktokId = activeTikTokContainer.dataset.tiktokId;
  const tiktok = savedTikToks.find((t) => t.id === tiktokId);
  const slider = activeTikTokContainer.querySelector(
    '.horizontal-slider',
  ) as HTMLElement;
  if (!slider || slider.children.length === 0 || !tiktok) return;

  stopSlideshow();

  isPlaying = true;
  document.body.classList.remove('slideshow-paused');

  // --- Browser TTS Playback Logic ---
  let currentSlideIndex = 0;
  const speakAndAdvance = () => {
    if (currentSlideIndex >= tiktok.slides.length || !isPlaying) {
      stopSlideshow();
      return;
    }

    const slide = slider.children[currentSlideIndex] as HTMLElement;
    slide?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'start',
    });

    const lyrics = tiktok.slides[currentSlideIndex].lyrics;
    if (!lyrics?.trim()) {
      currentSlideIndex++;
      speakAndAdvance();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(lyrics);

    // Find and set the selected voice
    if (tiktok.voiceName) {
      const voices = speechSynthesis.getVoices();
      const selectedVoice = voices.find(
        (voice) => voice.name === tiktok.voiceName,
      );
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }
    }

    utterance.onend = () => {
      currentSlideIndex++;
      speakAndAdvance();
    };
    utterance.onerror = (e: SpeechSynthesisErrorEvent) => {
      // Don't show an error if the speech was cancelled by the user stopping the slideshow.
      if (e.error === 'canceled' || e.error === 'interrupted') {
        console.warn(`Speech synthesis event: ${e.error}`);
        return; // It's not a "real" error, so we exit here.
      }
      console.error('SpeechSynthesis Error:', e.error, e);
      showErrorPopup(`Speech synthesis failed: ${e.error}`);
      stopSlideshow();
    };
    speechSynthesis.speak(utterance);
  };
  speakAndAdvance();
}

function stopSlideshow() {
  isPlaying = false;
  document.body.classList.add('slideshow-paused');
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
  }
}

function handleReplay() {
  if (!activeTikTokContainer) return;
  const slider = activeTikTokContainer.querySelector('.horizontal-slider');
  slider?.scrollTo({left: 0, behavior: 'smooth'});
  stopSlideshow();
  setTimeout(startSlideshow, 500);
}

// --- Theme Management ---

function setupTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    updateThemeIcons(true);
  } else {
    updateThemeIcons(false);
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  updateThemeIcons(isLight);
}

function updateThemeIcons(isLight: boolean) {
  if (themeToggle) {
    const sunIcon = themeToggle.querySelector('.sun-icon') as HTMLElement;
    const moonIcon = themeToggle.querySelector('.moon-icon') as HTMLElement;
    if (sunIcon && moonIcon) {
      sunIcon.style.display = isLight ? 'none' : 'block';
      moonIcon.style.display = isLight ? 'block' : 'none';
    }
  }
}

// --- Event Listeners Setup ---

function setupEventListeners() {
  slideshow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionTarget = target.closest('.action-icon');
    if (actionTarget?.classList.contains('replay-btn')) {
      handleReplay();
    } else if (!actionTarget) {
      isPlaying ? stopSlideshow() : startSlideshow();
    }
  });

  generateBtn.addEventListener('click', generate);

  themeToggle.addEventListener('click', toggleTheme);

  modalOverlay.addEventListener('click', () => {
    closeErrorPopup();
    closeApiKeyModal();
  });
  closeErrorModalBtn.addEventListener('click', closeErrorPopup);

  addApiBtn.addEventListener('click', openApiKeyModal);
  saveApiKeyBtn.addEventListener('click', handleSaveApiKey);
  closeApiKeyModalBtn.addEventListener('click', closeApiKeyModal);

  shortsStyleSelector.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLElement>('.style-btn');
    if (button?.dataset.style) {
      // Remove .selected from all buttons
      shortsStyleSelector.querySelectorAll('.style-btn').forEach((btn) => {
        btn.classList.remove('selected');
      });
      // Add .selected to the clicked button
      button.classList.add('selected');
      // Update state
      selectedStyle = button.dataset.style;
    }
  });

  characterSelector.addEventListener('change', () => {
    if (characterSelector.value === 'custom') {
      customCharacterInput.disabled = false;
      customCharacterInput.value = '';
      customCharacterInput.focus();
    } else if (characterSelector.value) {
      customCharacterInput.disabled = true;
      customCharacterInput.value = '';
    }
  });

  examplesSelector.addEventListener('change', () => {
    if (examplesSelector.value) {
      userInput.value = examplesSelector.value;
      generate();
      examplesSelector.selectedIndex = 0;
    }
  });

  historyGallery.addEventListener('click', (e) => {
    const thumb = (e.target as HTMLElement).closest<HTMLElement>(
      '.gallery-thumbnail',
    );
    if (thumb?.dataset.tiktokId) {
      const tiktok = savedTikToks.find((l) => l.id === thumb.dataset.tiktokId);
      tiktok?.element?.scrollIntoView({behavior: 'smooth'});
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === userInput || e.target === customCharacterInput) return;
    if (e.key === 'ArrowDown') navigateVertically('down');
    else if (e.key === 'ArrowUp') navigateVertically('up');
  });
}