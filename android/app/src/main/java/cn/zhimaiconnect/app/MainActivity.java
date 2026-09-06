package cn.zhimaiconnect.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(ZhimaiNativePlugin.class);
        super.onCreate(state);
    }
}
