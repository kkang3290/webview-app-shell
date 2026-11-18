package org.appshell;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.List;

/**
 * 麦克风输入枚举与路由。蓝牙耳机的麦克风只能走通话链路（HFP/SCO）：
 * Android 12+ 用 setCommunicationDevice，更早用 startBluetoothSco；录完必须恢复，否则影响其他 App 的音频。
 */
final class NativeRecorderInputs {
    private NativeRecorderInputs() {}

    static String typeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                return "builtin";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case 26: // TYPE_BLE_HEADSET (API 31)
                return "bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return "wired";
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "usb";
            default:
                return "other";
        }
    }

    static boolean isBluetooth(int type) {
        return "bluetooth".equals(typeName(type));
    }

    static AudioManager audio(Context context) {
        return (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
    }

    static AudioDeviceInfo find(Context context, String id) {
        if (id == null) return null;
        for (AudioDeviceInfo device : audio(context).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            if (Integer.toString(device.getId()).equals(id)) return device;
        }
        return null;
    }

    static JSArray list(Context context, int activeId) {
        JSArray inputs = new JSArray();
        for (AudioDeviceInfo device : audio(context).getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            String type = typeName(device.getType());
            if ("other".equals(type) && device.getType() != AudioDeviceInfo.TYPE_AUX_LINE) continue; // 遥控器、电话线等不是麦克风
            CharSequence product = device.getProductName();
            inputs.put(new JSObject()
                .put("id", Integer.toString(device.getId()))
                .put("type", type)
                .put("name", product == null ? type : product.toString())
                .put("active", device.getId() == activeId));
        }
        return inputs;
    }

    /** 把通话链路切到这个蓝牙设备；返回是否成功。 */
    @SuppressWarnings("deprecation")
    static boolean routeBluetooth(Context context, AudioDeviceInfo input) {
        AudioManager audio = audio(context);
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<AudioDeviceInfo> candidates = audio.getAvailableCommunicationDevices();
            for (AudioDeviceInfo device : candidates) {
                if (device.getType() == input.getType() && device.getAddress().equals(input.getAddress())) {
                    return audio.setCommunicationDevice(device);
                }
            }
            for (AudioDeviceInfo device : candidates) {
                if (isBluetooth(device.getType())) return audio.setCommunicationDevice(device);
            }
            return false;
        }
        audio.startBluetoothSco();
        audio.setBluetoothScoOn(true);
        return true;
    }

    @SuppressWarnings("deprecation")
    static void clearRouting(Context context) {
        AudioManager audio = audio(context);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice();
        } else if (audio.isBluetoothScoOn()) {
            audio.setBluetoothScoOn(false);
            audio.stopBluetoothSco();
        }
        audio.setMode(AudioManager.MODE_NORMAL);
    }
}
