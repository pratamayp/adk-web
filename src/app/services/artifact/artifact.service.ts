import { Injectable } from '@angular/core';

/**
 * The supported media types for artifacts.
 */
export enum MediaType {
  IMAGE = 'image',
  AUDIO = 'audio',
  TEXT = 'text', // for text/html
  UNSPECIFIED = 'unspecified',
}

/*
 * Returns the media type from the mime type.
 *
 * This function iterates through the MediaType enum values and checks if the
 * mime type starts with the enum value + '/'.
 *
 * If no matching prefix is found, it returns UNSPECIFIED.
 */
export function getMediaTypeFromMimetype(mimetype: string): MediaType {
  const lowerMime = mimetype.toLowerCase();

  for (const enumValue of Object.values(MediaType)) {
    if (enumValue === MediaType.UNSPECIFIED) {
      continue;
    }

    if (lowerMime.startsWith(enumValue + '/')) {
      return enumValue as MediaType;
    }
  }

  return MediaType.UNSPECIFIED;
}

/**
 * Returns true if the mime type is an image type.
 */
export function isArtifactImage(mimeType: string): boolean {
  if (!mimeType) {
    return false;
  }

  return mimeType.startsWith('image/');
}

/**
 * Returns true if the mime type is an audio type.
 */
export function isArtifactAudio(mimeType: string): boolean {
  if (!mimeType) {
    return false;
  }

  return mimeType.startsWith('audio/');
}

/**
 * Opens the base64 data in a new tab.
 */
export function openBase64InNewTab(dataUrl: string, mimeType: string) {
  try {
    if (!dataUrl) {
      return;
    }

    let base64DataString = dataUrl;

    if (dataUrl.startsWith('data:') && dataUrl.includes(';base64,')) {
      base64DataString = base64DataString.substring(
        base64DataString.indexOf(';base64,') + ';base64,'.length
      );
    }

    if (!mimeType || !base64DataString) {
      return;
    }

    const byteCharacters = atob(base64DataString);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);

    const blob = new Blob([byteArray], { type: mimeType });

    const blobUrl = URL.createObjectURL(blob);

    const newWindow = window.open(blobUrl, '_blank');
    if (newWindow) {
      newWindow.focus();
    } else {
      alert(
        'Pop-up blocked! Please allow pop-ups for this site to open the data in a new tab.'
      );
    }
  } catch (e) {
    alert(
      'Could not open the data. It might be invalid or too large. Check the browser console for errors.'
    );
  }
}

@Injectable({
  providedIn: 'root',
})
export class ArtifactService {
  constructor() {}
}
