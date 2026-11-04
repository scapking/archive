import { useEffect } from "react";
import { StyleSheet, View, Text } from "react-native";
import { router } from "expo-router";

export default function Index() {
    useEffect(() => {
        const timer = setTimeout(() => {
            router.replace("/(tabs)");
        }, 800 + Math.random() * 2400);

        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={styles.container}>
            <Text style={styles.text}>Who are you?</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: "100%",
        minHeight: "100%",
        backgroundColor: "#242424",
        justifyContent: "center",
        alignItems: "center",
    },
    text: {
        fontFamily: "System",
        fontSize: 24,
        fontWeight: "400",
        color: "#FFFFFF",
        textAlign: "center",
        includeFontPadding: false,
    },
});