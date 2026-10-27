import type { CDPSession } from 'playwright-core';

/** 浏览器级 CDP 通过子 session 执行，不创建可见的调试页面。 */
export async function evaluateTarget<T>(cdp: CDPSession, targetId: string, expression: string, userGesture = false, expectedOrigin?: string): Promise<T> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let receive: (event: { sessionId: string; message: string }) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('读取或恢复扩展视图超时。')), 5000);
      let evaluated = false;
      const evaluate = (contextId?: number) => {
        if (evaluated) return;
        evaluated = true;
        void cdp.send('Target.sendMessageToTarget', {
          sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression, awaitPromise: true, returnByValue: true, userGesture,
            ...(contextId == null ? {} : { contextId }),
          } }),
        }).catch(reject);
      };
      receive = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.method === 'Runtime.executionContextCreated') {
          const context = message.params.context;
          if (context.origin === expectedOrigin && context.auxData?.isDefault) evaluate(context.id);
          return;
        }
        if (message.id === 2 && message.error) { reject(new Error(message.error.message)); return; }
        if (message.id !== 1) return;
        if (message.error) reject(new Error(message.error.message));
        else if (message.result.exceptionDetails) {
          reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
        } else resolve(message.result.result?.value as T);
      };
      cdp.on('Target.receivedMessageFromTarget', receive);
      if (expectedOrigin) {
        void cdp.send('Target.sendMessageToTarget', {
          sessionId, message: JSON.stringify({ id: 2, method: 'Runtime.enable', params: {} }),
        }).catch(reject);
      } else evaluate();
    });
  } finally {
    clearTimeout(timer);
    cdp.off('Target.receivedMessageFromTarget', receive!);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
