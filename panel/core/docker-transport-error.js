import {HttpError} from '../common.js';

// Preserve status/message for private recovery and existing 404 control flow.
// The shared public diagnostic classifier must never treat daemon/broker text
// as an intentional application rejection merely because it is an HttpError.
export class DockerTransportError extends HttpError {
  constructor(status, message) {
    super(
      status,
      typeof message === 'string' ? message : 'The Docker request failed.',
    );
    this.name = 'DockerTransportError';
  }
}
