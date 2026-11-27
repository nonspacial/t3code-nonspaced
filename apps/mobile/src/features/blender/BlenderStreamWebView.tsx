import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { useGT } from "gt-react-native";
import { Platform } from "react-native";
import { WebView } from "react-native-webview";

import { deviceStreamBaseUrl, deviceStreamDocument } from "../devices/device-stream-document";
import {
  blenderStreamMessage,
  type BlenderStreamCommand,
  type BlenderStreamConfiguration,
  type BlenderStreamMessage,
} from "./blender-stream-document";

export interface BlenderStreamRef {
  readonly command: (command: BlenderStreamCommand) => void;
}

interface BlenderStreamWebViewProps {
  readonly ref?: Ref<BlenderStreamRef>;
  readonly access: BlenderStreamConfiguration["access"];
  readonly threadId: string;
  readonly colors: BlenderStreamConfiguration["colors"];
  readonly onMessage: (message: BlenderStreamMessage) => void;
  /** The WebView's page died or never loaded; a new view recovers it. */
  readonly onFailed: () => void;
}

// The stream player is about half a megabyte of JS, so it loads when a Blender screen first
// opens rather than with the app.
let loadedScript: string | null = null;
let loadingScript: Promise<string> | null = null;
const loadBlenderStreamScript = () =>
  (loadingScript ??= import("@t3tools/mobile-blender-stream").then((module) => {
    loadedScript = module.default;
    return module.default;
  }));

/** The thread's hosted Blender in a WebView, decoded with the shared H.264 stream player. */
export function BlenderStreamWebView(props: BlenderStreamWebViewProps) {
  const [script, setScript] = useState(loadedScript);
  const failed = useEffectEvent(() => props.onFailed());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the stream player's module, which isn't part of the app's startup
  useEffect(() => {
    if (script !== null) return;
    let live = true;
    loadBlenderStreamScript().then(
      (loaded) => {
        if (live) setScript(loaded);
      },
      () => {
        loadingScript = null;
        if (live) failed();
      },
    );
    return () => {
      live = false;
    };
  }, [script]);
  return script === null ? null : <BlenderStreamPage {...props} script={script} />;
}

function BlenderStreamPage({
  ref,
  script,
  ...props
}: BlenderStreamWebViewProps & { readonly script: string }) {
  const gt = useGT();
  const webView = useRef<WebView<object>>(null);
  const configuration = JSON.stringify({
    access: props.access,
    threadId: props.threadId,
    colors: props.colors,
    labels: { viewport: gt("Blender viewport") },
  } satisfies BlenderStreamConfiguration);
  const bootstrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const bootstrapTimedOut = useEffectEvent(() => props.onFailed());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times out a page that never reports, and stops the WebView's stream (its WebSocket and decoder) when this view unmounts
  useLayoutEffect(() => {
    const view = webView.current;
    // As the device viewer's: a page that loads but never starts its script reports nothing.
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      view?.injectJavaScript("window.T3BlenderStream?.stop(); true;");
    };
  }, []);
  useImperativeHandle(ref, () => ({
    command: (command) =>
      webView.current?.injectJavaScript(
        `window.T3BlenderStream?.command(${JSON.stringify(command)}); true;`,
      ),
  }));
  const source = {
    html: deviceStreamDocument(
      configuration,
      script,
      gt("Blender viewer stopped unexpectedly."),
      "T3BlenderStream",
    ),
    // WebCodecs needs a secure context, which Android's WebView gives only an https page.
    baseUrl: deviceStreamBaseUrl(Platform.OS, "android", props.access.httpBase),
  };
  return (
    <WebView<object>
      ref={webView}
      source={source}
      originWhitelist={["*"]}
      scrollEnabled={false}
      bounces={false}
      mixedContentMode="always"
      allowUniversalAccessFromFileURLs
      contentInsetAdjustmentBehavior="never"
      setSupportMultipleWindows={false}
      style={{ flex: 1, backgroundColor: props.colors.background }}
      onError={props.onFailed}
      onHttpError={props.onFailed}
      onContentProcessDidTerminate={props.onFailed}
      onRenderProcessGone={props.onFailed}
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" || request.url === source.baseUrl
      }
      onMessage={(event) => {
        const message = blenderStreamMessage(event.nativeEvent.data);
        if (message === null) return;
        clearBootstrapTimer();
        props.onMessage(message);
      }}
    />
  );
}
