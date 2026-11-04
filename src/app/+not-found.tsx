import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';




export default function NotFoundScreen() {
  return (
    <>
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 20, fontWeight: 'bold' }}>404 - Not Found</Text>
        <Text style={{ marginTop: 10, textAlign: 'center' }}>
          The page you are looking for does not exist.
        </Text>
        <Stack.Screen options={{ title: 'Oops!' }} />
        <Link href="/" style={{ marginTop: 20 }}>
          Go back to Home
        </Link>
      </SafeAreaView>
    </>
  );
}