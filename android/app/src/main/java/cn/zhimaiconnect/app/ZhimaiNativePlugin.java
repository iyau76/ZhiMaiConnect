package cn.zhimaiconnect.app;

import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ZhimaiNative")
public class ZhimaiNativePlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Map<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private WebView printView;

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void request(PluginCall call) {
        call.setKeepAlive(true);
        executor.execute(() -> {
            String id = call.getString("id");
            HttpURLConnection connection = null;
            try {
                URL url = new URL(call.getString("url"));
                if (!url.getProtocol().equals("https") && !url.getProtocol().equals("http"))
                    throw new IllegalArgumentException("HTTP or HTTPS required");
                connection = (HttpURLConnection) url.openConnection();
                connections.put(id, connection);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(call.getInt("timeoutMs", 120000));
                connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod(call.getString("method", "GET"));
                JSObject headers = call.getObject("headers", new JSObject());
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    connection.setRequestProperty(key, headers.getString(key));
                }
                String body = call.getString("bodyBase64");
                if (body != null) {
                    byte[] bytes = Base64.decode(body, Base64.DEFAULT);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                JSObject resultHeaders = new JSObject();
                for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if (entry.getKey() != null) resultHeaders.put(entry.getKey(), String.join(", ", entry.getValue()));
                }
                JSObject head = new JSObject();
                head.put("type", "headers"); head.put("status", status); head.put("headers", resultHeaders);
                call.resolve(head);
                InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (source != null) try (InputStream input = source) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        JSObject chunk = new JSObject();
                        chunk.put("type", "chunk"); chunk.put("data", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP));
                        call.resolve(chunk);
                    }
                }
                JSObject end = new JSObject(); end.put("type", "end"); call.resolve(end);
            } catch (Exception error) {
                JSObject failure = new JSObject(); failure.put("type", "error");
                failure.put("message", "网络请求失败（" + error.getClass().getSimpleName() + "）");
                call.resolve(failure);
            } finally {
                if (connection != null) connection.disconnect();
                connections.remove(id);
                call.setKeepAlive(false); getBridge().releaseCall(call);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        HttpURLConnection connection = connections.remove(call.getString("id"));
        if (connection != null) new Thread(connection::disconnect, "zhimai-cancel").start();
        call.resolve();
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "zhimai-backup.json"));
        startActivityForResult(call, intent, "fileSelected");
    }

    @PluginMethod
    public void printHtml(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (printView != null) printView.destroy();
            printView = new WebView(getContext());
            printView.getSettings().setJavaScriptEnabled(false);
            printView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                    String name = call.getString("name", "ZhiMai Connect");
                    manager.print(name, view.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
                    JSObject result = new JSObject(); result.put("name", name); call.resolve(result);
                }
            });
            printView.loadDataWithBaseURL(null, call.getString("html"), "text/html", "UTF-8", null);
        });
    }

    @ActivityCallback
    private void fileSelected(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        executor.execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt")) {
                output.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
                JSObject saved = new JSObject(); saved.put("name", call.getString("name")); call.resolve(saved);
            } catch (Exception error) { call.reject("文件未能保存，请重新选择位置"); }
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (HttpURLConnection connection : connections.values()) connection.disconnect();
        executor.shutdownNow();
        if (printView != null) getActivity().runOnUiThread(() -> printView.destroy());
    }
}
