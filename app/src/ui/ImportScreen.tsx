import { useState, type ReactNode } from 'react';
import { Alert, Modal, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ImportEngine, RecurringItem } from '../import';
import { ActionButton, Body, Card, colors, Field, Notice, Progress, Title } from './components';
import { Diagnostics } from './Diagnostics';
import { cadenceLabel, formatDate, formatMoney, formatName, formatSize, monthlyTotal } from './format';
import { useImport, type ImportController } from './useImport';
import { deleteFailed, screenFor, TEXT, uncertainText } from './viewModel';

export function ImportScreen({ engine }: { engine: ImportEngine }) {
  const controller = useImport(engine);
  return (
    <SafeAreaProvider>
      <Frame>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
          <Title>Импорт выписки</Title>
          <Content controller={controller} />
          <Diagnostics lastSync={controller.lastSync} />
        </ScrollView>
      </Frame>
    </SafeAreaProvider>
  );
}

/** Keeps content clear of the status bar, notch and gesture bar on both platforms. */
function Frame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[layout.root, { paddingTop: insets.top, paddingBottom: insets.bottom, overflow: 'hidden' }]}>
      {children}
    </View>
  );
}

function Content({ controller }: { controller: ImportController }) {
  const { snapshot, busy, candidate } = controller;
  const { record, result } = snapshot;
  const [detail, setDetail] = useState<RecurringItem | null>(null);

  if (busy === 'restoring') return <Progress>Проверяем, есть ли незавершённый импорт…</Progress>;

  if (candidate && !record) {
    return (
      <>
        <Card>
          <Field label="Файл" value={candidate.name} />
          <Field label="Размер" value={formatSize(candidate.size)} />
          <Field label="Формат (по содержимому)" value={formatName(candidate.format)} />
        </Card>
        <Body muted>Файл будет отправлен на сервер для разбора. Временная копия на устройстве удалится после отправки.</Body>
        <ActionButton title="Отправить" onPress={controller.send} busy={busy === 'sending'} />
        <ActionButton title="Отмена" kind="secondary" onPress={controller.cancelCandidate} disabled={busy !== null} />
      </>
    );
  }

  const screen = screenFor(snapshot);
  const failedDelete = deleteFailed(record);
  const deleteButton = (
    <ActionButton
      title={failedDelete ? 'Повторить удаление' : 'Удалить импорт'}
      kind="danger"
      onPress={controller.requestDelete}
      busy={busy === 'deleting'}
      disabled={busy !== null}
    />
  );
  const deleteNotice = failedDelete && (
    <Notice tone="error">Удалить не удалось. Данные импорта по-прежнему на сервере. Попробуйте ещё раз.</Notice>
  );
  const offlineNotice = controller.offline && <Notice tone="warning">Нет связи с сервером. Повторяем запрос…</Notice>;
  const failureNotice = controller.failure && <Notice tone="error">Действие не выполнено. Попробуйте ещё раз.</Notice>;

  switch (screen.kind) {
    case 'empty':
      return (
        <>
          <Body>Импортов пока нет. Выберите банковскую выписку в формате PDF или CSV, до 10 МБ.</Body>
          {controller.rejection && <Notice tone="error">{TEXT.rejection[controller.rejection]}</Notice>}
          {controller.rejection && <Body muted>Файл не отправлялся на сервер, копия на устройстве удалена.</Body>}
          {controller.abandoned && (
            <Notice tone="warning">
              Импорт закрыт без подтверждения. Если он всё же был создан на сервере, приложение попробует удалить его
              при следующих запусках, но подтвердить удаление сейчас не может. Копия файла на устройстве удалена.
            </Notice>
          )}
          {failureNotice}
          <ActionButton title="Выбрать файл" onPress={controller.pick} busy={busy === 'checking'} />
        </>
      );

    case 'sending':
      return <Progress>Отправляем файл на сервер…</Progress>;

    case 'uncertain':
      return (
        <>
          <Notice tone="warning">{uncertainText(record?.errorCode ?? null)}</Notice>
          <Body muted>
            Сначала мы спросим сервер, есть ли уже этот импорт. Файл отправится повторно, только если его там нет, и
            второй импорт не появится.
          </Body>
          {failureNotice}
          <ActionButton
            title="Проверить и повторить"
            onPress={controller.retry}
            busy={busy === 'retrying'}
            disabled={busy !== null}
          />
          <ActionButton
            title="Выйти без подтверждения"
            kind="danger"
            busy={busy === 'closing'}
            disabled={busy !== null}
            onPress={() =>
              Alert.alert(
                'Выйти без подтверждения?',
                'Мы ещё раз спросим сервер. Если импорт найдётся, вы сможете удалить его обычным способом. ' +
                  'Если сервер не ответит, импорт может остаться на сервере: приложение попробует удалить его при ' +
                  'следующих запусках, но не сможет показать подтверждение.',
                [
                  { text: 'Остаться', style: 'cancel' },
                  { text: 'Выйти', style: 'destructive', onPress: controller.abandon },
                ],
              )
            }
          />
        </>
      );

    case 'rejected':
      return (
        <>
          <Notice tone="error">
            {record?.errorCode === 'copy_missing' ? TEXT.rejected.copy_missing : TEXT.rejected.fallback}
          </Notice>
          <ActionButton title="Закрыть" onPress={controller.close} busy={busy === 'closing'} />
        </>
      );

    case 'missing':
      return (
        <>
          <Notice tone="warning">
            Сервер не знает этот импорт. Это не подтверждение удаления: мы не можем сказать, что стало с данными.
          </Notice>
          <ActionButton title="Закрыть" onPress={controller.close} busy={busy === 'closing'} />
        </>
      );

    case 'progress':
      return (
        <>
          <Progress>
            {screen.status === 'queued'
              ? 'Файл принят и ждёт в очереди. Отчёт ещё не готов.'
              : 'Сервер обрабатывает выписку. Отчёт ещё не готов.'}
          </Progress>
          {offlineNotice}
          {deleteNotice}
          {failureNotice}
          {deleteButton}
        </>
      );

    case 'loadingReport':
      return (
        <>
          <Progress>Загружаем готовый отчёт…</Progress>
          {offlineNotice}
          {deleteNotice}
          {deleteButton}
        </>
      );

    case 'ready': {
      const items = result?.items ?? [];
      const currency = result?.currency ?? '';
      return (
        <>
          <Notice tone="success">Отчёт готов.</Notice>
          {items.length === 0 && <Body>Регулярных списаний не найдено.</Body>}
          {items.map(item => (
            <Card key={item.id}>
              <Field label="Получатель" value={item.merchant} />
              <Field label="Сумма" value={`${formatMoney(item.amountMinor, currency)}, ${cadenceLabel(item.cadence)}`} />
              <Field label="Последнее списание" value={formatDate(item.lastSeen)} />
              <ActionButton title="Подробнее" kind="secondary" onPress={() => setDetail(item)} />
            </Card>
          ))}
          {items.length > 0 && (
            <Card>
              <Field label="Итого в месяц" value={formatMoney(monthlyTotal(items), currency)} />
            </Card>
          )}
          {deleteNotice}
          {failureNotice}
          <ActionButton
            title="Обновить статус"
            kind="secondary"
            onPress={controller.refresh}
            busy={busy === 'refreshing'}
            disabled={busy !== null}
          />
          {deleteButton}
          <DetailModal item={detail} currency={currency} onClose={() => setDetail(null)} />
        </>
      );
    }

    case 'deleting':
      return (
        <>
          <Progress>Удаление запрошено. Ждём подтверждения от сервера — данные ещё не удалены.</Progress>
          {offlineNotice}
        </>
      );

    case 'deleted':
      return (
        <>
          <Notice tone="success">Сервер подтвердил: импорт удалён. Копий файла на устройстве нет.</Notice>
          {failureNotice}
          <ActionButton title="Готово" onPress={controller.close} busy={busy === 'closing'} />
        </>
      );
  }
}

/** Read-only details of one recurring charge. There is deliberately no "cancel subscription" here. */
function DetailModal(props: { item: RecurringItem | null; currency: string; onClose: () => void }) {
  const { item } = props;
  return (
    <Modal visible={item !== null} animationType="slide" onRequestClose={props.onClose}>
      <SafeAreaProvider>
        <Frame>
          <ScrollView contentContainerStyle={layout.content}>
          <Title>{item?.merchant ?? ''}</Title>
          {item && (
            <Card>
              <Field label="Сумма" value={formatMoney(item.amountMinor, props.currency)} />
              <Field label="Периодичность" value={cadenceLabel(item.cadence)} />
              <Field label="Последнее списание" value={formatDate(item.lastSeen)} />
              <Field label="Идентификатор" value={item.id} />
            </Card>
          )}
          <Body muted>Это справочная карточка. Отменить подписку отсюда нельзя.</Body>
          <ActionButton title="Закрыть" onPress={props.onClose} />
          </ScrollView>
        </Frame>
      </SafeAreaProvider>
    </Modal>
  );
}

const layout = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 32, gap: 16 },
});
