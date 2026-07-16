import { resolveConversationDirection } from './conversationDirection.ts';

function runTests() {
  console.log("=========================================");
  console.log("RUNNING CONVERSATION DIRECTION RESOLVER TESTS");
  console.log("=========================================");

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, details?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}${details ? ' — ' + details : ''}`);
      failed++;
    }
  }

  // Test 1: Tamil speech with pair ta/en
  const t1 = resolveConversationDirection({
    detectedLanguage: 'ta',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'வணக்கம்'
  });
  assert('Tamil speech resolved to first panel', 
    t1.status === 'resolved' && t1.sourceLanguage === 'ta' && t1.targetLanguage === 'en' && t1.sourcePanel === 'first'
  );

  // Test 2: English speech with pair ta/en
  const t2 = resolveConversationDirection({
    detectedLanguage: 'en',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'Hello'
  });
  assert('English speech resolved to second panel', 
    t2.status === 'resolved' && t2.sourceLanguage === 'en' && t2.targetLanguage === 'ta' && t2.sourcePanel === 'second'
  );

  // Test 3: Hindi detection with pair ta/en produces mismatch state
  const t3 = resolveConversationDirection({
    detectedLanguage: 'hi',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'नमस्ते'
  });
  assert('Hindi detection produces language-mismatch', 
    t3.status === 'language-mismatch' && t3.sourcePanel === 'unknown'
  );

  // Test 4: Null language with no script and no stopwords => auto-defaults to first language
  const t4 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'blah blah blah blah'
  });
  assert('Null language with gibberish defaults to first language (no broken modal)', 
    t4.status === 'resolved' && t4.sourceLanguage === 'ta' && t4.sourcePanel === 'first',
    `got status=${t4.status} source=${t4.sourceLanguage}`
  );

  // Test 5: Short ambiguous speech reuses previous direction
  const t5 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: 'ta',
    transcript: 'Ok'
  });
  assert('Short ambiguous speech reuses previous direction', 
    t5.status === 'resolved' && t5.sourceLanguage === 'ta' && t5.inferredFromPrevious === true
  );

  // Test 6: Empty string detected language with no script defaults to first language
  const t6 = resolveConversationDirection({
    detectedLanguage: '',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'xyz abc def ghi jkl'
  });
  assert('Empty string detected language defaults to first language', 
    t6.status === 'resolved' && t6.sourceLanguage === 'ta',
    `got status=${t6.status} source=${t6.sourceLanguage}`
  );

  // Test 7: Unicode Tamil script detection override when detectedLanguage is null
  const t7 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'நல்லது, நன்றி!'
  });
  assert('Script detection resolves Tamil characters to first panel', 
    t7.status === 'resolved' && t7.sourceLanguage === 'ta' && t7.sourcePanel === 'first'
  );

  // Test 8: English stop word detection override when detectedLanguage is null
  const t8 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'please translate this sentence'
  });
  assert('Stop-word detection resolves English words to second panel', 
    t8.status === 'resolved' && t8.sourceLanguage === 'en' && t8.sourcePanel === 'second'
  );

  // Test 9: Telugu script detection
  const t9 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'te',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'నమస్కారం'
  });
  assert('Telugu script detection resolves to first panel',
    t9.status === 'resolved' && t9.sourceLanguage === 'te' && t9.sourcePanel === 'first'
  );

  // Test 10: Kannada script detection
  const t10 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'kn',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'ನಮಸ್ಕಾರ'
  });
  assert('Kannada script detection resolves to first panel',
    t10.status === 'resolved' && t10.sourceLanguage === 'kn' && t10.sourcePanel === 'first'
  );

  // Test 11: Malayalam script detection
  const t11 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ml',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'നമസ്കാരം'
  });
  assert('Malayalam script detection resolves to first panel',
    t11.status === 'resolved' && t11.sourceLanguage === 'ml' && t11.sourcePanel === 'first'
  );

  // Test 12: Bengali script detection
  const t12 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'bn',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'নমস্কার'
  });
  assert('Bengali script detection resolves to first panel',
    t12.status === 'resolved' && t12.sourceLanguage === 'bn' && t12.sourcePanel === 'first'
  );

  // Test 13: Devanagari as Marathi when mr is in the pair
  const t13 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'mr',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'नमस्कार'
  });
  assert('Devanagari script resolves to Marathi when mr is in pair',
    t13.status === 'resolved' && t13.sourceLanguage === 'mr' && t13.sourcePanel === 'first'
  );

  // Test 14: Arabic script resolves to Urdu when ur is in pair
  const t14 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ur',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'السلام علیکم'
  });
  assert('Arabic script resolves to Urdu when ur is in pair',
    t14.status === 'resolved' && t14.sourceLanguage === 'ur' && t14.sourcePanel === 'first'
  );

  // Test 15: Spanish stop words
  const t15 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'es',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'hola buenos dias'
  });
  assert('Spanish stop-word detection resolves correctly',
    t15.status === 'resolved' && t15.sourceLanguage === 'es' && t15.sourcePanel === 'first'
  );

  // Test 16: Chinese characters
  const t16 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'zh',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: '你好世界'
  });
  assert('Chinese character detection resolves correctly',
    t16.status === 'resolved' && t16.sourceLanguage === 'zh' && t16.sourcePanel === 'first'
  );

  // Test 17: Korean characters  
  const t17 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ko',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: '안녕하세요'
  });
  assert('Korean character detection resolves correctly',
    t17.status === 'resolved' && t17.sourceLanguage === 'ko' && t17.sourcePanel === 'first'
  );

  console.log("=========================================");
  console.log(`TESTS FINISHED: ${passed} PASSED, ${failed} FAILED`);
  console.log("=========================================");
}

runTests();
