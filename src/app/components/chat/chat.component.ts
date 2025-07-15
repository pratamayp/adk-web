/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DOCUMENT, Location } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  ViewChild,
  WritableSignal,
  signal,
} from '@angular/core';
import { FormControl } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatDrawer } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  distinctUntilChanged,
  filter,
  map,
  Observable,
  of,
  shareReplay,
  switchMap,
  take,
  tap,
} from 'rxjs';

import { URLUtil } from '../../../utils/url-util';
import { AgentRunRequest } from '../../core/models/AgentRunRequest';
import { Session } from '../../core/models/Session';
import { AgentService } from '../../core/services/agent.service';
import { AudioService } from '../../core/services/audio.service';
import { FeatureFlagService } from '../../core/services/feature-flag.service';
import { SessionService } from '../../core/services/session.service';
import { VideoService } from '../../core/services/video.service';

import { ViewImageDialogComponent } from '../view-image-dialog/view-image-dialog.component';
import { WebSocketService } from '../../core/services/websocket.service';
import { DeleteSessionDialogComponent } from '../session-tab/delete-session-dialog/delete-session-dialog.component';
import { SessionTabComponent } from '../session-tab/session-tab.component';
import {
  getMediaTypeFromMimetype,
  MediaType,
  openBase64InNewTab,
} from '../../core/services/artifact.service';

const BIDI_STREAMING_RESTART_WARNING =
  'Restarting bidirectional streaming is not currently supported. Please refresh the page or start a new session.';

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoContainer', { read: ElementRef })
  videoContainer!: ElementRef;
  @ViewChild('sideDrawer') sideDrawer!: MatDrawer;
  @ViewChild(SessionTabComponent) sessionTab!: SessionTabComponent;
  @ViewChild('autoScroll') private scrollContainer!: ElementRef;

  private _snackBar = inject(MatSnackBar);

  videoElement!: HTMLVideoElement;
  currentMessage = '';
  messages: any[] = [];
  lastTextChunk: string = '';
  streamingTextMessage: any | null = null;
  latestThought: string = '';
  userInput: string = '';
  userId = 'user';
  appName = '';
  sessionId = ``;
  isAudioRecording = false;
  isVideoRecording = false;
  showSidePanel = true;
  useSse = false;
  currentSessionState = {};

  private readonly messagesSubject = new BehaviorSubject<any[]>([]);
  private readonly streamingTextMessageSubject = new BehaviorSubject<
    any | null
  >(null);
  private readonly scrollInterruptedSubject = new BehaviorSubject(true);
  private readonly isModelThinkingSubject = new BehaviorSubject(false);

  sessionHasUsedBidi = new Set<string>();

  getMediaTypeFromMimetype = getMediaTypeFromMimetype;

  selectedFiles: { file: File; url: string }[] = [];

  protected openBase64InNewTab = openBase64InNewTab;
  protected MediaType = MediaType;

  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  protected readonly selectedAppControl = new FormControl<string>('', {
    nonNullable: true,
  });

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  private readonly agentService = inject(AgentService);
  protected isLoadingApps: WritableSignal<boolean> = signal(false);
  protected loadingError: WritableSignal<string> = signal('');
  protected readonly apps$: Observable<string[] | undefined> = of([]).pipe(
    tap(() => {
      this.isLoadingApps.set(true);
      this.selectedAppControl.disable();
    }),
    switchMap(() =>
      this.agentService.listApps().pipe(
        catchError((err: HttpErrorResponse) => {
          this.loadingError.set(err.message);
          return of(undefined);
        })
      )
    ),
    take(1),
    tap((app) => {
      this.isLoadingApps.set(false);
      this.selectedAppControl.enable();
      if (app?.length == 1) {
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { app: app[0] },
        });
      }
    }),
    shareReplay()
  );

  private readonly featureFlagService = inject(FeatureFlagService);
  isSessionUrlEnabledObs = this.featureFlagService.isSessionUrlEnabled();

  constructor(
    private sessionService: SessionService,
    private audioService: AudioService,
    private webSocketService: WebSocketService,
    private videoService: VideoService,
    private dialog: MatDialog,
    private route: ActivatedRoute,
    private location: Location
  ) {}

  ngOnInit(): void {
    this.syncSelectedAppFromUrl();
    this.updateSelectedAppUrl();

    this.webSocketService.onCloseReason().subscribe((closeReason) => {
      const error =
        'Please check server log for full details: \n' + closeReason;
      this.openSnackBar(error, 'OK');
    });

    const location = new URL(window.location.href);
    const searchParams = location.searchParams;
    if (searchParams.has('code')) {
      const authResponseUrl = window.location.href;
      window.opener?.postMessage({ authResponseUrl }, window.origin);
      window.close();
    }

    this.agentService.getApp().subscribe((app) => {
      this.appName = app;
    });

    combineLatest([
      this.agentService.getLoadingState(),
      this.isModelThinkingSubject,
    ]).subscribe(([isLoading, isModelThinking]) => {
      const lastMessage = this.messages[this.messages.length - 1];

      if (isLoading) {
        if (!lastMessage?.isLoading && !this.streamingTextMessage) {
          this.messages.push({ role: 'bot', isLoading: true });
          this.messagesSubject.next(this.messages);
        }
      } else if (lastMessage?.isLoading && !isModelThinking) {
        this.messages.pop();
        this.messagesSubject.next(this.messages);
        this.changeDetectorRef.detectChanges();
      }
    });

    combineLatest([
      this.messagesSubject,
      this.scrollInterruptedSubject,
      this.streamingTextMessageSubject,
    ]).subscribe(([messages, scrollInterrupted, streamingTextMessage]) => {
      if (!scrollInterrupted) {
        setTimeout(() => {
          this.scrollToBottom();
        }, 100);
      }
    });
  }

  ngAfterViewInit() {
    this.showSidePanel = true;
    this.changeDetectorRef.detectChanges();
  }

  scrollToBottom() {
    setTimeout(() => {
      this.scrollContainer.nativeElement.scrollTo({
        top: this.scrollContainer.nativeElement.scrollHeight,
        behavior: 'smooth',
      });
    });
  }

  selectApp(appName: string) {
    if (appName != this.appName) {
      this.agentService.setApp(appName);

      this.isSessionUrlEnabledObs.subscribe((sessionUrlEnabled) => {
        const sessionUrl = this.activatedRoute.snapshot.queryParams['session'];

        if (!sessionUrlEnabled || !sessionUrl) {
          this.createSessionAndReset();
          return;
        }

        if (sessionUrl) {
          this.sessionService
            .getSession(this.userId, this.appName, sessionUrl)
            .pipe(
              take(1),
              catchError((error) => {
                this.openSnackBar(
                  'Cannot find specified session. Creating a new one.',
                  'OK'
                );
                this.createSessionAndReset();
                return of(null);
              })
            )
            .subscribe((session) => {
              if (session) {
                this.updateWithSelectedSession(session);
              }
            });
        }
      });
    }
  }

  private createSessionAndReset() {
    this.createSession();
    this.messages = [];
    this.userInput = '';
  }

  createSession() {
    this.sessionService
      .createSession(this.userId, this.appName)
      .subscribe((res) => {
        this.currentSessionState = res.state;
        this.sessionId = res.id;
        this.sessionTab.refreshSession();

        this.isSessionUrlEnabledObs.subscribe((enabled) => {
          if (enabled) {
            this.updateSelectedSessionUrl();
          }
        });
      });
  }

  async sendMessage(event: Event) {
    if (this.messages.length === 0) {
      this.scrollContainer.nativeElement.addEventListener('wheel', () => {
        this.scrollInterruptedSubject.next(true);
      });
      this.scrollContainer.nativeElement.addEventListener('touchmove', () => {
        this.scrollInterruptedSubject.next(true);
      });
    }
    this.scrollInterruptedSubject.next(false);

    event.preventDefault();
    if (!this.userInput.trim() && this.selectedFiles.length <= 0) return;

    if (event instanceof KeyboardEvent) {
      if (event.isComposing) {
        return;
      }
    }

    if (!!this.userInput.trim()) {
      this.messages.push({ role: 'user', text: this.userInput });
      this.messagesSubject.next(this.messages);
    }

    if (this.selectedFiles.length > 0) {
      const messageAttachments = this.selectedFiles.map((file) => ({
        file: file.file,
        url: file.url,
      }));
      this.messages.push({ role: 'user', attachments: messageAttachments });
      this.messagesSubject.next(this.messages);
    }

    const req: AgentRunRequest = {
      appName: this.appName,
      userId: this.userId,
      sessionId: this.sessionId,
      newMessage: {
        role: 'user',
        parts: await this.getUserMessageParts(),
      },
      streaming: this.useSse,
    };
    this.selectedFiles = [];
    let index = this.messages.length - 1;
    this.streamingTextMessage = null;
    this.agentService.runSse(req).subscribe({
      next: async (chunk) => {
        if (chunk.startsWith('{"error"')) {
          this.openSnackBar(chunk, 'OK');
          return;
        }
        const chunkJson = JSON.parse(chunk);
        if (chunkJson.error) {
          this.openSnackBar(chunkJson.error, 'OK');
          return;
        }
        if (chunkJson.content) {
          for (let part of chunkJson.content.parts) {
            this.processPart(chunkJson, part, index);
          }
        }
        this.changeDetectorRef.detectChanges();
      },
      error: (err) => console.error('SSE error:', err),
      complete: () => {
        this.streamingTextMessage = null;
        this.sessionTab.reloadSession(this.sessionId);
      },
    });
    this.userInput = '';
    this.changeDetectorRef.detectChanges();
  }

  private processPart(chunkJson: any, part: any, index: number) {
    if (part.text) {
      this.isModelThinkingSubject.next(false);
      const newChunk = part.text;
      if (part.thought) {
        if (newChunk !== this.latestThought) {
          const processedText = this.processThoughtText(newChunk);
          if (processedText) {
            // Only show thought if it has content
            let thoughtMessage = {
              role: 'bot',
              text: processedText,
              thought: true,
            };
            this.insertMessageBeforeLoadingMessage(thoughtMessage);
          }
        }
        this.latestThought = newChunk;
      } else if (!this.streamingTextMessage) {
        this.streamingTextMessage = {
          role: 'bot',
          text: this.processThoughtText(newChunk),
          thought: part.thought ? true : false,
        };

        this.insertMessageBeforeLoadingMessage(this.streamingTextMessage);

        if (!this.useSse) {
          this.streamingTextMessage = null;
          return;
        }
      } else {
        if (newChunk == this.streamingTextMessage.text) {
          this.streamingTextMessage = null;
          return;
        }
        this.streamingTextMessage.text += newChunk;
        this.streamingTextMessageSubject.next(this.streamingTextMessage);
      }
    } else if (!part.thought) {
      this.isModelThinkingSubject.next(false);
      this.storeMessage(
        part,
        chunkJson,
        index,
        chunkJson.author === 'user' ? 'user' : 'bot'
      );
    } else {
      this.isModelThinkingSubject.next(true);
    }
  }

  async getUserMessageParts() {
    let parts: any = [];

    if (!!this.userInput.trim()) {
      parts.push({ text: `${this.userInput}` });
    }

    if (this.selectedFiles.length > 0) {
      for (const file of this.selectedFiles) {
        parts.push({
          inlineData: {
            displayName: file.file.name,
            data: await this.readFileAsBytes(file.file),
            mimeType: file.file.type,
          },
        });
      }
    }
    return parts;
  }

  readFileAsBytes(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const base64Data = e.target.result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private storeMessage(part: any, e: any, index: number, role: string) {
    let message: any = { role };
    if (part.inlineData) {
      const base64Data = this.formatBase64Data(
        part.inlineData.data,
        part.inlineData.mimeType
      );
      message.inlineData = {
        displayName: part.inlineData.displayName,
        data: base64Data,
        mimeType: part.inlineData.mimeType,
      };
    } else if (part.text) {
      message.text = part.text;
      message.thought = part.thought ? true : false;
    }

    // Only insert the message if it has renderable content.
    if (message.text || message.inlineData) {
      this.insertMessageBeforeLoadingMessage(message);
    }
  }

  private insertMessageBeforeLoadingMessage(message: any) {
    const lastMessage = this.messages[this.messages.length - 1];
    if (lastMessage?.isLoading) {
      this.messages.splice(this.messages.length - 1, 0, message);
    } else {
      this.messages.push(message);
    }
    this.messagesSubject.next(this.messages);
  }

  private formatBase64Data(data: string, mimeType: string) {
    return `data:${mimeType};base64,${data}`;
  }

  ngOnDestroy(): void {
    this.webSocketService.closeConnection();
  }

  onAppSelection(event: any) {
    if (this.isAudioRecording) {
      this.stopAudioRecording();
      this.isAudioRecording = false;
    }
    if (this.isVideoRecording) {
      this.stopVideoRecording();
      this.isVideoRecording = false;
    }
  }

  toggleAudioRecording() {
    this.isAudioRecording
      ? this.stopAudioRecording()
      : this.startAudioRecording();
  }

  startAudioRecording() {
    if (this.sessionHasUsedBidi.has(this.sessionId)) {
      this.openSnackBar(BIDI_STREAMING_RESTART_WARNING, 'OK');
      return;
    }

    this.isAudioRecording = true;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.webSocketService.connect(
      `${protocol}://${URLUtil.getWSServerUrl()}/run_live?app_name=${
        this.appName
      }&user_id=${this.userId}&session_id=${this.sessionId}`
    );
    this.audioService.startRecording();
    this.messages.push({ role: 'user', text: 'Speaking...' });
    this.messages.push({ role: 'bot', text: 'Speaking...' });
    this.messagesSubject.next(this.messages);
    this.sessionHasUsedBidi.add(this.sessionId);
  }

  stopAudioRecording() {
    this.audioService.stopRecording();
    this.webSocketService.closeConnection();
    this.isAudioRecording = false;
  }

  toggleVideoRecording() {
    this.isVideoRecording
      ? this.stopVideoRecording()
      : this.startVideoRecording();
  }

  startVideoRecording() {
    if (this.sessionHasUsedBidi.has(this.sessionId)) {
      this.openSnackBar(BIDI_STREAMING_RESTART_WARNING, 'OK');
      return;
    }

    this.isVideoRecording = true;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.webSocketService.connect(
      `${protocol}://${URLUtil.getWSServerUrl()}/run_live?app_name=${
        this.appName
      }&user_id=${this.userId}&session_id=${this.sessionId}`
    );
    this.videoService.startRecording(this.videoContainer);
    this.audioService.startRecording();
    this.messages.push({ role: 'user', text: 'Speaking...' });
    this.messagesSubject.next(this.messages);
    this.sessionHasUsedBidi.add(this.sessionId);
  }

  stopVideoRecording() {
    this.audioService.stopRecording();
    this.videoService.stopRecording(this.videoContainer);
    this.webSocketService.closeConnection();
    this.isVideoRecording = false;
  }

  toggleSidePanel() {
    this.showSidePanel = !this.showSidePanel;
  }

  private resetEventsAndMessages() {
    this.messages = [];
    this.messagesSubject.next(this.messages);
  }

  protected updateWithSelectedSession(session: Session) {
    if (!session || !session.id || !session.events || !session.state) {
      return;
    }
    this.sessionId = session.id;
    this.currentSessionState = session.state;

    this.isSessionUrlEnabledObs.subscribe((enabled) => {
      if (enabled) {
        this.updateSelectedSessionUrl();
      }
    });

    this.resetEventsAndMessages();
    let index = 0;

    session.events.forEach((event: any) => {
      event.content?.parts?.forEach((part: any) => {
        if (part.text || part.inlineData) {
          this.storeMessage(
            part,
            event,
            index,
            event.author === 'user' ? 'user' : 'bot'
          );
          index += 1;
        }
      });
    });
  }

  protected updateSessionState(session: Session) {
    this.currentSessionState = session.state;
  }

  onNewSessionClick() {
    this.createSession();
    this.messages = [];
  }

  onFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i];
        const url = URL.createObjectURL(file);
        this.selectedFiles.push({ file, url });
      }
    }
    input.value = '';
  }

  removeFile(index: number) {
    URL.revokeObjectURL(this.selectedFiles[index].url);
    this.selectedFiles.splice(index, 1);
  }

  toggleSse() {
    this.useSse = !this.useSse;
  }

  protected deleteSession(session: string) {
    const dialogData = {
      title: 'Confirm delete',
      message: `Are you sure you want to delete this session ${this.sessionId}?`,
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel',
    };

    const dialogRef = this.dialog.open(DeleteSessionDialogComponent, {
      width: '600px',
      data: dialogData,
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.sessionService
          .deleteSession(this.userId, this.appName, session)
          .subscribe((res) => {
            const nextSession = this.sessionTab.refreshSession(session);
            if (nextSession) {
              this.sessionTab.getSession(nextSession.id);
            } else {
              window.location.reload();
            }
          });
      }
    });
  }

  private syncSelectedAppFromUrl() {
    combineLatest([
      this.router.events.pipe(
        filter((e) => e instanceof NavigationEnd),
        map(() => this.activatedRoute.snapshot.queryParams)
      ),
      this.apps$,
    ]).subscribe(([params, apps]) => {
      if (apps && apps.length) {
        const app = params['app'];
        if (app && apps.includes(app)) {
          this.selectedAppControl.setValue(app);
        } else if (app) {
          this.openSnackBar(`Agent '${app}' not found`, 'OK');
        }
      }
    });
  }

  private updateSelectedAppUrl() {
    this.selectedAppControl.valueChanges
      .pipe(distinctUntilChanged(), filter(Boolean))
      .subscribe((app: string) => {
        this.selectApp(app);

        const selectedAgent = this.activatedRoute.snapshot.queryParams['app'];
        if (app === selectedAgent) {
          return;
        }
        this.router.navigate([], {
          queryParams: { app: app },
          queryParamsHandling: 'merge',
        });
      });
  }

  private updateSelectedSessionUrl() {
    const url = this.router
      .createUrlTree([], {
        queryParams: { session: this.sessionId },
        queryParamsHandling: 'merge',
      })
      .toString();
    this.location.replaceState(url);
  }

  openSnackBar(message: string, action: string) {
    this._snackBar.open(message, action);
  }

  private processThoughtText(text: string) {
    return text.replace('/*PLANNING*/', '').replace('/*ACTION*/', '');
  }

  openViewImageDialog(imageData: string | null) {
    this.dialog.open(ViewImageDialogComponent, {
      maxWidth: '90vw',
      maxHeight: '90vh',
      data: {
        imageData,
      },
    });
  }
}
