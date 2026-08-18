import {
  NetworkError,
  type NetworkProtocol,
} from "./index.ts";

export function unsupportedNetworkOperation(
  operation: string,
  protocol: NetworkProtocol,
): NetworkError {
  return new NetworkError(`${operation} is not admitted by this PocketJS build`, {
    category: "runtime",
    code: "unsupported",
    operation,
    protocol,
  });
}

export function unsupportedNetworkPromise<T>(
  operation: string,
  protocol: NetworkProtocol,
): Promise<T> {
  return Promise.reject(unsupportedNetworkOperation(operation, protocol));
}
