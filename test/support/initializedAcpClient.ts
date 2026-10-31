import * as acp from "@agentclientprotocol/sdk/unstable";

/**
 * Connect a test client using the ACP initialize handshake required before
 * sending any other request. Explicit initialize requests in the operation are
 * passed through and are not duplicated.
 */
export function connectWithAcpInitialization<T>(
  client: acp.ClientApp,
  target: acp.AgentApp,
  operation: (context: acp.ClientContext) => T | Promise<T>,
): Promise<T> {
  return client.connectWith(target, async (context) => {
    let initialized = false;
    const request = context.request.bind(context);
    const initializedContext = new Proxy(context, {
      get(targetContext, property, receiver) {
        if (property !== "request") return Reflect.get(targetContext, property, receiver);
        return async (method: string, params: unknown) => {
          if (method === acp.methods.agent.initialize) {
            const result = await request(method, params);
            initialized = true;
            return result;
          }
          if (!initialized) {
            await request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
            });
            initialized = true;
          }
          return request(method, params);
        };
      },
    });
    return operation(initializedContext);
  });
}
