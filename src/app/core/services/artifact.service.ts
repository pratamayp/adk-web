/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { URLUtil } from '../../../utils/url-util';

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
  apiServerDomain = URLUtil.getApiServerBaseUrl();
  constructor(private http: HttpClient) {}

  getLatestArtifact(
    userId: string,
    appName: string,
    sessionId: string,
    artifactName: string
  ) {
    const url =
      this.apiServerDomain +
      `/apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${artifactName}`;

    return this.http.get<any>(url);
  }

  getArtifactVersion(
    userId: string,
    appName: string,
    sessionId: string,
    artifactName: string,
    versionId: string
  ) {
    const url =
      this.apiServerDomain +
      `/apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${artifactName}/versions/${versionId}`;

    return this.http.get<any>(url);
  }
}
