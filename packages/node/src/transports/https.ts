import { eventToSentryRequest, sessionToSentryRequest } from '@sentry/core';
import { Event, Response, Session, TransportOptions } from '@sentry/types';
import { SentryError } from '@sentry/utils';
import * as https from 'https';

import { BaseTransport } from './base';

/** Node https module transport */
export class HTTPSTransport extends BaseTransport {
  /** Create a new instance and set this.agent */
  public constructor(public options: TransportOptions) {
    super(options);
    const proxy = this._getProxy('https');
    this.module = https;
    this.client = proxy
      ? (new (require('https-proxy-agent'))(proxy) as https.Agent)
      : new https.Agent({ keepAlive: false, maxSockets: 30, timeout: 2000 });
  }

  /**
   * @inheritDoc
   */
  public sendEvent(event: Event): Promise<Response> {
    if (!this.module) {
      throw new SentryError('No module available in HTTPSTransport');
    }
    return this._sendWithModule(this.module, eventToSentryRequest(event, this._api), event);
  }

  /**
   * @inheritDoc
   */
  public sendSession(session: Session): PromiseLike<Response> {
    if (!this.module) {
      throw new SentryError('No module available in HTTPTransport');
    }
    return this._sendWithModule(this.module, sessionToSentryRequest(session, this._api), session);
  }
}
